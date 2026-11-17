# References

Notation models deploy-time outputs, credentials, prior-state lookups, lazy computations, and multi-module parameter merging with branded token types from `@notation/resource`.

## Reference types

All reference tokens implement `RefMembers<T, K>` with a brand symbol (`Symbol.for("@notation/resource/OutputRef")`), `kind`, `resource`, `resourceId`, and `path`:

```ts [@notation/resource]
export interface OutputRef<T = unknown> {
  readonly kind: "output";
  readonly resource: BaseResource;
  readonly resourceId: string;
  readonly path: readonly string[];
  map<U>(fn: (value: T) => U): Derived<U>;
}

export interface CredentialRef<T = unknown> {
  readonly kind: "credential";
  readonly resource: BaseResource;
  readonly resourceId: string;
  readonly path: readonly string[];
}

export interface StateRef<T = unknown> {
  readonly kind: "state";
  readonly resource: BaseResource;
  readonly resourceId: string;
  readonly path: readonly string[];
}

export type AnyOutputRef = OutputRef | CredentialRef | StateRef;
```

Resources expose references through three APIs:

| API | Reference returned |
| :--- | :--- |
| `resource.outputRef(key)` | `OutputRef<T>` for a non-credential schema property |
| `resource.credentials.<key>` | `CredentialRef<T>` for a `credential` schema property |
| `resource["~state"].outputRef(key)` | `StateRef<T>` backed by the initial state snapshot |

`outputRef(key)` throws if `key` is a `credential` property. Placing an `OutputRef` or `CredentialRef` in another resource's `config` or `contribute()` adds a dependency edge, while `CredentialRef` keeps secret values out of persisted state. `StateRef` resolves to `T | undefined` and adds no dependency edge. Self-references to a resource's own `physicalName` parameter add no dependency edge.

### Type guards

Use the brand-based type guards from `@notation/resource` instead of `instanceof` so checks work across symlinked or bundled package copies:

| Helper | Narrows to |
| :--- | :--- |
| `isOutputRef(value)` | `AnyOutputRef` |
| `isCredentialRef(value)` | `CredentialRef` |
| `isStateRef(value)` | `StateRef` |
| `isDerived(value)` | `Derived` |

`isOutputRef(value)` returns `true` for `OutputRef`, `CredentialRef`, and `StateRef`.

## Deferred references

`deferredOutputRef(options)` creates an `OutputRef` for a resource whose `BaseResource` instance does not exist until infrastructure modules finish loading (such as `$worker.url`):

```ts [@notation/resource]
export type DeferredOutputRefOptions<
  R extends BaseResource | undefined,
  K extends string,
> = {
  resourceId: string;
  key: K;
  resolve: () => R;
};

export function deferredOutputRef<
  R extends BaseResource | undefined,
  K extends OutputKeyOf<NonNullable<R>> & string,
>(
  options: DeferredOutputRefOptions<R, K>,
): OutputRef<OutputValueOf<NonNullable<R>, K>>;
```

`DeferredOutputRef` records `resourceId` and `[key]` immediately so dependency sorting and error formatting work before resolution:

- **Deferred lookup** – Reading `ref.resource` while infrastructure evaluation is still open throws an error.
- **Validation on first read** – Once evaluation finishes, `resolve()` is called, verified to return a resource whose `id` matches `resourceId`, and cached.

## Derived values

`Derived<T>` computes a value lazily from one or more `OutputRef` or `Derived` inputs during `plan` (when upstream values exist in state) and `deploy`. Every `Derived<T>` instance exposes `.map<U>(fn): Derived<U>`.

### String interpolation

`text` is a tagged template literal that concatenates strings, numbers, `OutputRef`, and `Derived` values into a `Derived<string>`:

```ts [@notation/resource]
export function text(
  strings: TemplateStringsArray,
  ...parts: Input<string | number>[]
): Derived<string>;
```

At runtime, each resolved part must be a `string` or `number`. Passing a `CredentialRef` or `StateRef` throws immediately.

### Tuple composition

`all(refs)` combines a tuple of `OutputRef` and `Derived` inputs into a `Derived` tuple so `.map()` can compute from multiple outputs:

```ts [@notation/resource]
export function all<
  const R extends readonly (OutputRef<any> | Derived<any>)[],
>(
  refs: R,
): Derived<{ -readonly [K in keyof R]: Resolved<R[K]> }>;
```

Passing a `CredentialRef` or `StateRef` to `all()` throws immediately.

### Mapping values

Calling `ref.map(fn)` or `derived.map(fn)` transforms a single input into `Derived<U>`, subject to four synchronous purity rules:

| Rule | Behavior |
| :--- | :--- |
| Promises | Returning a promise or thenable throws |
| Nested refs | Returning an `OutputRef` or `Derived` at any depth throws |
| Non-durable types | Returning a `function`, `bigint`, `symbol`, or non-plain class instance throws |
| Secret or state refs | Calling `.map()` on a `CredentialRef` or `StateRef` throws |

Thenables are detected via `typeof value.then === "function"`. To combine multiple references, pass them to `all([...])`. If a `Derived` depends on a resource's own `physicalName` reference, resolution throws because own physical names are assigned after parameters and can only be placed whole.

## State references

`resource["~state"].outputRef(key)` creates a `StateRef<T>` that reads an attribute from the state snapshot captured at the start of `plan` or `deploy`:

| Rule | Behavior |
| :--- | :--- |
| Dependency edge | Adds no dependency edge to the target resource |
| Snapshot lookup | Reads the state snapshot captured when `plan` or `deploy` begins |
| Placement | Allowed only in `contribute()`, never in `resource.config` |
| Allowed keys | Target `key` must be a non-hidden, replace-triggering schema `param` |

When the target has no full state record, `StateRef` resolves to `undefined`; if the target is replaced in the same deploy, `StateRef` holds the pre-replacement value. Valid target params must have `hidden` unset and at least one of `immutable`, `primaryKey`, `secondaryKey`, or `physicalName`. `StateRef` tokens also cannot be passed to `text`, `map()`, or `all()`.

## String conversion errors

Reference tokens and `Derived` instances extend `Unstringable`, overriding `[Symbol.toPrimitive]()`, `toString()`, and `toJSON()` to throw `OutputRefStringError`. Always place tokens whole or combine them with `text`, `map()`, and `all()`.

## Contributions

Resources with `collect` rules on schema parameters accept independent additions via `resource.contribute(values)` typed by `ContributionInput<T["collected"]>`. Contributions and `resource.dependOn(other)` follow four rules:

| Rule | Behavior |
| :--- | :--- |
| Open evaluation | Throws if called after evaluation ends or after params are read |
| Collected keys | Rejects any key without a `collect` rule on its schema `param` |
| Deterministic order | Sorts contributions canonically by content, then call site |
| Map merging | `mergeContributions` merges plain objects by key and assigns scalars and arrays whole |

Calling `contribute()` or `dependOn()` after the resource's dependencies have been read also throws. Sorting canonically by content ensures import order never causes spurious diffs.

### Conflict errors

When two contributors (or `config` and a contributor) set the same scalar or array path to different values, `mergeContributions` throws `ContributionConflictError`:

```ts [@notation/resource]
export class ContributionConflictError extends Error {
  readonly resourceId: string;
  readonly path: string;
  readonly contributors: [string, string];
}
```

When a conflicting value holds an `OutputRef` or `Derived`, conflict detection defers until `deploy` resolves the concrete values.

### Deprecated callback form

The callback overload `contribute(compute, { deps })` is `@deprecated`:

```ts [@notation/resource]
// @deprecated
resource.contribute(
  ({ deps }) => ({ ... }),
  { deps: { upstream } },
);
```

Prefer placing `OutputRef<T>` whole in `contribute(values)` or computing values with `text`, `map()`, and `all()`. See [References Internals](../internals/references.md) for resolution details.
