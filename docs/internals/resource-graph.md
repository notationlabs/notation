# Resource Graph

`@notation/resource` collects every resource and resource group created while infrastructure modules load into a single `ResourceGraph`. It drains end-of-evaluation callbacks and pending declaration validations before sealing the graph.

## Collection lifecycle

A project must load only one copy of `@notation/resource` because module-level state tracks the active collection. At module load, `claimSingleCopy(import.meta.url)` records the module URL on `globalThis[Symbol.for("@notation/resource/loaded")]` and throws if a second copy claims the slot.

`collectResourceGraph(evaluate, opts?)` creates a `ResourceCollection`, sets it as `activeCollection`, and runs the collection sequence:

```ts [packages/resource/src/resource-collection.ts]
export type ResourceGraph = {
  resourceGroups: ResourceGroup[];
  resources: BaseResource[];
};

export type CollectOptions = {
  scope?: NameScope;
  declarationChecks?: boolean;
};

export type ResourceCollection = {
  graph: ResourceGraph;
  closed: boolean;
  evaluationEnded: boolean;
  endOfEvaluation: Array<() => unknown | Promise<unknown>>;
  pendingValidations: Promise<void>[];
  declarationChecks: boolean;
  scope?: NameScope;
  stores: Map<string, unknown>;
};
```

Calling `collectResourceGraph` while another collection is active throws immediately. On completion, the `finally` block sets `collection.closed = true` and clears `activeCollection` so later contributions fail.

## End-of-evaluation queue

Provider helpers and compiler-generated bindings use `onEvaluationEnd(callback)` to defer wiring that depends on all modules finishing evaluation. Calling `onEvaluationEnd` outside an active collection throws.

Once `await evaluate()` finishes, `collectResourceGraph` sets `collection.evaluationEnded = true` (exposed via `evaluationEnded()`) and drains `collection.endOfEvaluation` in strict FIFO order:

```ts [packages/resource/src/resource-collection.ts]
collection.evaluationEnded = true;
while (collection.endOfEvaluation.length > 0) {
  await collection.endOfEvaluation.shift()!();
}
await Promise.all(collection.pendingValidations);
```

Because the loop checks `endOfEvaluation.length > 0` on every iteration, a callback can call `onEvaluationEnd` to append follow-up work to the tail before contributions close.

## Pending declaration validations

When `Resource` subclasses finish constructing, they call `checkDeclaration()` unless `opts.declarationChecks` is `false` (`notation destroy` disables checks so invalid config does not block teardown). Synchronous Standard Schema validators throw directly from the constructor.

Async validators return a `Promise<void>` that cannot reject from a synchronous constructor. `checkDeclaration()` attaches a no-op `.catch(() => {})` handler to prevent unhandled-rejection crashes during loading, then pushes the promise to `collection.pendingValidations` if `!collection.closed`. `collectResourceGraph` awaits `Promise.all(collection.pendingValidations)` after `endOfEvaluation` empties, failing collection with the first validation error.

## Per-collection stores

`perCollection(key, create)` creates a store isolated to the active `ResourceCollection`:

```ts [packages/resource/src/resource-collection.ts]
export function perCollection<T>(
  key: string,
  create: () => T,
): () => T | undefined {
  return () => {
    const stores = activeCollection?.stores;
    if (!stores) return undefined;
    if (!stores.has(key)) stores.set(key, create());
    return stores.get(key) as T;
  };
}
```

The returned accessor returns `undefined` when no collection is active and invokes `create()` once per `key` per collection. Separate installed copies of a provider package passing the same string `key` (such as `"@notation/cloudflare/workers"`) share one store entry within a collection without leaking state across runs.

## Resource groups

`ResourceGroup` organizes resources and nested subgroups under a shared container with `type`, `id`, `config`, `resources`, and `groups`. When constructed during an active collection, the constructor pushes `this` into `collection.graph.resourceGroups`.

### Parent chains

Each `ResourceGroup` maintains a private `#parent: ResourceGroup | null` pointer:

- **`parent`** (`ResourceGroupRef | null`) – returns `this.#parent?.ref ?? null` for top-level vs nested inspection.
- **`ref`** (`ResourceGroupRef`) – walks `#parent` upward, unshifting `{ type, id }` entries so `parents` is ordered from the outermost ancestor down to the immediate parent.

`group.add(member)` attaches either a resource or a child group:

- **Adding a resource** – Rejects if `resource.group` is already set. Pushes `resource` to `this.#graph.resources` if absent (supporting resources constructed outside an active collection), assigns `resource.group = this.ref`, and appends to `this.resources`.
- **Adding a subgroup** – Joins the subgroup tree into `this.#graph` via `#join(graph)`, assigns `subgroup.#parent = this`, and recursively calls `#updateRefs()` so nested resources receive the updated `ResourceGroupRef`.

### Cycle detection

Before attaching a child group in `#addGroup(group)`, `ResourceGroup` walks the target's ancestor chain from `this` up through `#parent`:

```ts [packages/resource/src/resource-group.ts]
for (let ancestor: ResourceGroup | null = this; ancestor; ancestor = ancestor.#parent) {
  if (ancestor === group) {
    throw new Error(
      `Group ${group.type} "${group.id}" can't be added to ${
        group === this ? "itself" : `group ${this.type} "${this.id}", which it contains`
      }.`,
    );
  }
}
```

It also throws if `group.#parent` is already set, enforcing a strict tree structure where every group has at most one parent.

### Idempotent registration

`group.addOnce(ResourceClass, id, ...args)` deduplicates shared binding resources (such as an API route integration) that multiple modules may attempt to create:

```ts [packages/resource/src/resource-group.ts]
const existing = this.resources.find((r) => r.id === id);
if (!existing) {
  return this.add(new ResourceClass(id, ...args) as InstanceType<T>);
}
if (existing.constructor !== ResourceClass) {
  throw new Error(
    `Resource ${id} already exists as ${existing.type} in group ${this.type}.`,
  );
}
return existing as InstanceType<T>;
```

If a resource with the same `id` already belongs to the group, `addOnce` verifies `existing.constructor === ResourceClass` before returning it.

## Graph uniqueness

`ResourceGroup` enforces `(type, id)` uniqueness across `graph.resourceGroups` via `assertUniqueGroup(graph, type, id)`. This check runs in the `ResourceGroup` constructor (when a collection is active) and in `#join(graph)` (when a group created outside a collection joins a graph).

Individual `Resource` instances deduplicate by object identity in `ResourceGroup.add`, which rejects any resource whose `resource.group` is already assigned. The reconciler enforces resource ID uniqueness across the deployment graph when building dependency levels and strongly connected units, alongside provider-level ID guards (such as `$lambda` and `$worker`).

## Declaration metadata

`@notation/build` wraps compiled resource declarations in `declaredIn(value, path, binding, moduleExports?)` to attach module provenance without polluting enumerable properties:

```ts [packages/resource/src/declared-in.ts]
const declaredInKey = Symbol.for("@notation/declaredIn");

export function declaredIn<T>(
  value: T,
  path: string,
  binding: string,
  moduleExports?: DeclaredExports,
): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.defineProperty(value, declaredInKey, {
      value: { path, binding, ...moduleExports },
    });
  }
  return value;
}
```

`getDeclaredIn(value)` reads `value[declaredInKey]` to retrieve `DeclaredIn` (`path`, `binding`, and optional `exports` or `starExports` for runtime bundling). Separately, `Resource` attaches an enumerable `declaredAt` getter using `captureCallSiteLazily` from [Contributions](./contributions.md) so errors report `file:line` while object spreads preserve the property.
