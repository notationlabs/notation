# References

`@notation/resource` represents cross-resource wiring using branded reference tokens and lazy `Derived` computations rather than raw strings or eager values. The engine can then build the dependency graph before any provider calls run.

## Reference kinds

All reference tokens implement `RefMembers<T, K>` with these fields:

| Field | Purpose |
| :--- | :--- |
| `[outputRefBrand]` | Cross-copy brand keyed by `Symbol.for("@notation/resource/OutputRef")` |
| `kind` | Discriminator set to `"output"`, `"credential"`, or `"state"` |
| `"~value"` | Phantom type marker preventing cross-type assignment across refs |
| `resource` | Target `BaseResource` instance |
| `resourceId` | Target resource ID known at creation time |
| `path` | Property path segments under the resource output |

Type guards `isOutputRef`, `isCredentialRef`, and `isStateRef` check `outputRefBrand` and `kind` rather than `instanceof`.

### Output references

`OutputRef<T>` (`kind: "output"`) represents a standard output value produced when a resource deploys. Calling `resource.outputRef(key)` creates `new OutputRef(this, [key])`, throwing if `this.schema[key]?.propertyType === "credential"`.

Placing an `OutputRef` in config or a static contribution adds a dependency edge from the holder to the referenced resource unless `isOwnNameRef` is true. `OutputRef<T>` exposes `.map(fn)` to transform the resolved value into a `Derived<U>`.

### Credential references

`CredentialRef<T>` (`kind: "credential"`) represents a secret returned by `create` or `rotate`, exposed via `resource.credentials.<key>` (`new OutputRef(this, [key], "credential")`). It adds a dependency edge to the producer, but cannot be passed to `text`, `all`, or `.map()` because derived results are stored as plain parameters in state.

At runtime, deploy resolves `CredentialRef` tokens into `CredentialMarker` objects (`{ $credential: { resource, name, version } }`) for state storage. The in-memory secret is substituted only when invoking a provider operation.

### State references

`StateRef<T>` (`kind: "state"`) reads an output from the target resource's state record at the start of plan or deploy. It is typed as `StateRef<T | undefined>` because a resource without a full state record resolves to `undefined` via `recordedLookup`. Calling `resource["~state"].outputRef(key)` delegates to `stateOutputRef(resource, key)` and marks `#stateRefTarget = true` on the target resource.

`stateOutputRef` enforces two schema role constraints:

- **No hidden params** – throws if `item?.propertyType === "param" && item.hidden`, because hidden params are omitted from state records.
- **Replace-only fields** – throws unless `item?.propertyType === "param"` and at least one of `immutable`, `primaryKey`, `secondaryKey`, or `physicalName` is set. This prevents reading mutable params or computed outputs that would lag by one deploy.

A `StateRef` adds no dependency (`isDependencyRef` returns `false`) and cannot be passed to `text` or `all`. It can only appear in a contribution – `getFixedDependencies()` throws if a `StateRef` is placed in `resource.config`.

## Deferred output references

`deferredOutputRef(options)` constructs a `DeferredOutputRef` when a resource's ID is known before the `BaseResource` instance exists (for example, inside an `onEvaluationEnd` callback):

```ts [packages/resource/src/output-ref.ts]
export type DeferredOutputRefOptions<
  R extends BaseResource | undefined,
  K extends string,
> = {
  resourceId: string;
  key: K;
  resolve: () => R;
};
```

`DeferredOutputRef` stores `resourceId`, `[key]`, `"output"`, `#resolve`, and the active `ResourceCollection` at creation time. Accessing `ref.resource` throws while `#collection && !#collection.evaluationEnded`, then calls `#resolve()`, verifies `resource?.id === this.resourceId`, and caches `#resource`. Because `resourceId` and `path` are fixed upfront, canonical sorting and error messages work before `resolve()` runs.

## Stringification traps

Both `RefBase` and `Derived` extend `Unstringable`, which intercepts implicit string and JSON conversions:

```ts [packages/resource/src/output-ref.ts]
abstract class Unstringable {
  protected abstract stringError(): OutputRefStringError;

  [Symbol.toPrimitive](): never {
    throw this.stringError();
  }

  toString(): never {
    throw this.stringError();
  }

  toJSON(): never {
    throw this.stringError();
  }
}
```

Interpolating a ref into a plain JS template literal, concatenating with `+`, or calling `JSON.stringify` directly throws `OutputRefStringError` instead of silently serializing `"[object Object]"`.

## Derived values

`Derived<T>` (branded with `Symbol.for("@notation/resource/Derived")`) stores `"~inputs"`, `"~compute"`, and `"~describe"`, delaying computation until all referenced inputs are known. Three constructors produce `Derived` instances:

| Constructor | Purpose |
| :--- | :--- |
| `` text`...` `` | Joins literals, primitives, refs, and derived values into `Derived<string>` |
| `all(refs)` | Combines a tuple of `OutputRef` and `Derived` values into one array input |
| `.map(fn)` | Transforms a resolved `OutputRef` or `Derived` value into `Derived<U>` |

`text` validates that every input resolves to a `string` or `number`. Both `text` and `all` omit their call sites from `"~describe"` so moving calls across files does not reorder contributions. `.map(fn)` captures a lazy V8 call site for error reporting and `"~describe"`, wraps `fn` errors with the call site, and validates the return value with `assertRecordable`.

During resolution (`resolveDerived`), any `UNKNOWN_AFTER_APPLY` input (such as a rotating credential at plan time) causes the `Derived` to resolve to `{ known: false }`. If an input resolves to an `OwnPhysicalName` marker, `resolveDerived` throws because a resource's own physical name can only be placed whole.

### Derivability checks

`assertDerivable(value, where)` runs inside `text`, `all`, and `RefBase.prototype.map`. It rejects `CredentialRef` values (which cannot compute into plain state params) and `StateRef` values (which can only appear whole in contributions).

### Recordability checks

`assertRecordable(value, where)` validates every value returned by `.map(fn)` so params remain serializable in state:

| Rule | Requirement |
| :--- | :--- |
| No promises | Rejects thenables where `typeof value.then === "function"` |
| No nested refs | Rejects values containing an `OutputRef` or `Derived` via `containsRefOrDerived` |
| Durable primitives | Rejects functions, `bigint`, `symbol`, and non-plain objects via `findUnrecordable` |

All ref inputs to a `.map(fn)` callback must be declared upfront via `all()`, and non-array objects must have `Object.prototype` or `null` as their prototype.

## Own physical name references

`isOwnNameRef(owner, token)` returns `true` when `token.resourceId === owner.id`, `token.path.length === 1`, `token.resource === owner`, and `owner.schema[token.path[0]]` is a `param` with `physicalName`. Because `isDependencyRef(holder, token)` returns `!isStateRef(token) && !isOwnNameRef(holder, token)`, referencing a resource's own generated name introduces no self-dependency.

In `Resource.#resolveRefs`, own-name refs resolve to `ownPhysicalName(token.path[0])` (`{ "~physicalName": field }`) instead of reading `owner.output`. See [Physical Names](./physical-names.md) for how `fillPhysicalNames` substitutes the generated name.

## Config views

`deriveParamsConfigView(owner, config, onPending?)` wraps `config` with `guardedReadView` before passing it to `deriveParams`, placing enumerable getters at paths containing guarded markers:

- **`OwnPhysicalName`** – throws because deploy assigns physical names after `deriveParams` runs.
- **`CredentialMarker`** – throws because deploy substitutes credential secrets only when calling provider operations.
- **Unresolved refs or `UNKNOWN_AFTER_APPLY`** – when `onPending` is passed (at plan time), calls `onPending(value, owner, param)`, which sets `views.readPending = true` and throws `PendingOutput`.

## Plan views

`createPlanViews()` builds dependency proxies for `deriveParams` and deprecated function contributions during planning. Each proxy uses `Object.create(dep, ...)` so `outputRef`, `credentials`, and `"~state"` bind to the underlying `dep` instance, ensuring created refs point to `dep` rather than the proxy.

When code reads `dep.output` at plan time:

- **Missing output** – if `dep.output == null`, the getter sets `views.readPending = true` and throws `PendingOutput(dep)`.
- **Missing required fields** – if `missingRequiredOutputs(dep, output)` is non-empty, `planOutput` returns `{ ...output }` with enumerable getters on each missing field. Reading a missing field sets `views.readPending = true` and throws `PendingOutput(dep)` while preserving `in` and `Object.keys` parity with deploy.

`tryAtPlan(views, run)` checks `views.readPending` on both return and `catch`. Even if `deriveParams` catches `PendingOutput`, `readPending === true` causes `planParams()` to fall back to `#cautiousPlanParams`, marking every param absent from `config` as `UNKNOWN_AFTER_APPLY`.

## Deploy views

`deployViews(deps)` wraps each dependency with `Object.create(dep, ...)` and replaces `dep.config` with a lazy getter backed by `deriveParamsConfigView(dep, resolveOutputRefs(dep.config, deployLookup))`. `deployLookup` reads `token.resource.output` and throws if the target resource is not deployed yet; `Output` and `config` getters memoize once computed, while throws are not cached.

## Input type helpers

`output-ref.ts` exports recursive type utilities that wire `OutputRef`, `CredentialRef`, `StateRef`, and `Derived` into resource configs and contributions:

| Type | Definition |
| :--- | :--- |
| `Input<T>` | Union of `T`, `OutputRef<T>`, and `Derived<T>` |
| `DeepInput<T>` | Recursively applies `Input` across objects, arrays, and unions |
| `DeepInputWith<T, Also>` | Extends `DeepInput<T>` with `CredentialRef` or `StateRef` support |
| `Resolved<T>` | Unwraps `OutputRef`, `CredentialRef`, or `Derived` to its value type |
| `ResolvedValues<T>` | Maps each property `K` of `T` through `Resolved<T[K]>` |

`DeepInput<T>` aliases `DeepInputWith<T, never>`. `DeepInputWith<T, Also>` permits `CredentialRef<T>` when `"credential"` is in `Also`, and permits `StateRef<T>` on properties accepting `undefined` when `"state"` is in `Also`. `Resolved<T>` leaves non-ref types unchanged.
