# Contributions

Collected parameters let multiple modules append or merge configuration into a shared resource. Ordering and conflict detection stay deterministic regardless of import order.

## Schema collection hooks

A schema item with `propertyType: "param"` becomes collected when it defines a `collect(items, context)` hook:

```ts [packages/resource/src/resource.schema.ts]
collect?(items: CollectItem<T>[], context: CollectContext): T;
```

Because `collect` is declared as a method signature, TypeScript treats its parameter bivariantly. A rule can accept a narrower item shape (such as `(items: Binding[][]) => items.flat()`) while still satisfying `SchemaItem`. `Contributions<S>` extracts all collected params from the schema and makes them optional in `ConfigParams<T>`.

`CollectItem<T>` shapes each contributed item using `DeepPartial` and `DeepPartialValue`:

```ts [packages/resource/src/types.ts]
export type DeepPartial<T> = {
  [P in keyof T]?: DeepPartialValue<T[P]>;
};

export type DeepPartialValue<T> = T extends readonly (infer E)[]
  ? T extends unknown[]
    ? DeepPartialValue<E>[]
    : readonly DeepPartialValue<E>[]
  : T extends object
    ? DeepPartial<T>
    : T;
```

Object properties become deeply optional so each contributor can supply a subset of keys. Array elements stay required (`DeepPartialValue<E>[]`) because an `undefined` slot would persist in a merged list. Writing the array branch directly as an array type also defers TypeScript expansion so recursive JSON types terminate.

`Resource.#checkContribution` rejects any contributed key whose schema item is not a `param` with `collect`, and drops `undefined` entries. At parameter resolution time, `Resource.#collect` skips calling `collect` when there are no configured or contributed items. At plan time, it returns `UNKNOWN_AFTER_APPLY` immediately if a deprecated function contribution read a pending output.

## Lazy call-site capture

Every call to `resource.contribute(...)` captures its call site using `captureCallSiteLazily(Resource.prototype.contribute, { skipLibraryFrames: true })`. Instead of parsing stack frames upfront, `captureCallSiteLazily` calls V8's `Error.captureStackTrace(holder, below)` and defers reading `holder.stack`:

```ts [packages/resource/src/contributions.ts]
const limit = ErrorClass.stackTraceLimit;
if (opts.skipLibraryFrames) ErrorClass.stackTraceLimit = 100;
try {
  capture(holder, below);
} finally {
  ErrorClass.stackTraceLimit = limit;
}
```

Raising `stackTraceLimit` to `100` prevents internal helper frames from exhausting V8's default limit of `10`. V8 formats and source-maps `holder.stack` lazily on first read, which occurs only when `sortContributions` hits an exact value tie or `mergeContributions` throws a conflict error.

When formatted, `findCallSite` parses `file:line` (`file://` decoded) and strips `process.cwd()`. It skips frames inside `/node_modules/`, `node:`, or `@notation/*` (`notationPackagesDir`, detected at module load), falling back to the first frame if all frames were skipped.

## Canonical output formatting

To compare and sort contributions before outputs are known, `toCanonicalOutputRefs(value)` replaces every reference token and `Derived` instance with a stable canonical string:

| Token | Format |
| :--- | :--- |
| `OutputRef` | `` `<output ${resourceId}.${path.join(".")}>` `` |
| `CredentialRef` | `` `<output ${resourceId}.${path.join(".")}>` `` |
| `StateRef` | `` `<output ${resourceId}.${path.join(".")}>` `` |
| `text` | Joins literal segments with canonicalized child tokens |
| `all` | `` `<all of ${refs...}>` `` |
| `map` | `` `<map of ${input} at ${site}>` `` |

Because `text` and `all` omit call-site metadata, moving their calls across files does not alter sort order.

## Canonical contribution sorting

`sortContributions(items, valueOf)` produces an order independent of module evaluation order by encoding each item's canonicalized value with `sortedJson.encode`:

```ts [packages/utils/src/sorted-json.ts]
export const sortedJson = {
  encode(value: unknown): string {
    return JSON.stringify(value, (_key, entry) => sortKeys(entry)) ?? "null";
  },
  decode(text: string): unknown {
    return JSON.parse(text);
  },
};
```

`sortedJson.encode` copies every non-array object with keys sorted lexicographically while preserving array order and `JSON.stringify` semantics for `undefined` and `toJSON`. `sortContributions` sorts items lexicographically by that encoded string and breaks exact ties using `item.contributor()`.

Inside `Resource.#collect`, contributions are sorted first. If `config[key]` is defined, it is prepended via `items.unshift(...)` with contributor `"the config of <id>"` so explicit config always precedes contributions. Each item then resolves refs via `#resolveRefs` before `collect(resolvedItems, context)` runs, letting `collect` rules inspect real values whenever outputs exist.

## Map merge conflicts

`mergeContributions` is the built-in `collect` rule for record parameters. It deep-merges plain objects (`isPlainObject`) key by key via `mergeInto`. Primitives, arrays, and non-plain values are treated atomically.

An `owners` map (`Map<string, number>`) records the contributor index for each `JSON.stringify(path)` key. `ownerOf(path)` walks from deepest path to shallowest to resolve contributor call-site strings lazily only when a conflict occurs.

When two items set the same leaf key to `existing` and `value`:

1. **Equal canonical values** – if `sortedJson.encode(toCanonicalOutputRefs(existing)) === sortedJson.encode(toCanonicalOutputRefs(value))`, the duplicate entry is ignored without error.
2. **Unresolved output refs** – if `containsOutputRef(value)` is true, `target[key] = value` overwrites without throwing; if `containsOutputRef(existing)` is true, `existing` is kept. Because unresolved `OutputRef` and `Derived` values cannot be compared yet, conflict detection defers to deploy, where `getParams()` resolves refs first and re-runs `mergeContributions`.
3. **Conflicting values** – otherwise, `mergeInto` throws `ContributionConflictError(resourceId, path, [owner, contributor], [existing, value])`, displaying both values with `sortedJson.encode(toCanonicalOutputRefs(...))`.

## Resource sealing

Every `Resource` maintains a private `#sealed` flag starting at `false`. Reading a resource's graph or parameter views flips `#sealed = true`:

- `getOutputRefs()`
- `getFixedDependencies()` (also called by `getDependencies()`)
- `getContributedParams()`
- `getParams()`
- `planParams()`

Both `contribute(...)` and `dependOn(...)` invoke `#assertOpen(action)`. It throws if `this.#collection?.closed` (`"evaluation has ended"`) or `this.#sealed` (`"its params have already been read"`), preventing new contributions or dependency edges once parameters or dependencies are observed.
