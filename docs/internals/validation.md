# Validation

`@notation/resource` checks resource schemas against provider API types at compile time and normalizes parameter diffs for planning. At runtime, it validates values with Standard Schema V1 across seven lifecycle points while filtering unknown placeholders and redacting secrets.

## Compile-time schema verification

Every `defineResource<ApiSchema>(meta)` call binds a four-part API contract (`Key`, `CreateParams`, `UpdateParams`, `ReadResult`) to `.defineSchema(schema)`.

### API schema constraints

`SchemaFromApi<ApiCompoundKey, ApiCreateParams, ApiUpdateParams, ApiReadResult>` enforces structural parity between a resource's schema and its provider API types:

| Check | Requirement |
| :--- | :--- |
| Compound keys | `ApiCompoundKey` keys require `primaryKey: true` or `secondaryKey: true` |
| Required params | Required `ApiCreateParams` keys require `propertyType: "param"` and `presence: "required"` |
| Optional params | Optional `ApiCreateParams` keys require `propertyType: "param"` and `presence: "optional"` |
| Immutable params | Keys absent from `ApiUpdateParams` require `propertyType: "param"` and `immutable: true` |
| Computed outputs | `ApiReadResult` keys absent from create and key types require `propertyType: "computed"` |

Required and optional param checks exclude keys in `ApiCompoundKey`, and immutable checks cover keys in `ApiCreateParams` absent from `ApiUpdateParams`. Each `SchemaItem<T>` specifies `value: StandardSchemaV1<T, T>`. Input and output types must match so transforming validators and schema-injected defaults do not compile.

### Resource type inference

Inside `.defineSchema(schema)`, `ResolveSchema<S>` pairs each item with `resolvedType: Durable<StandardSchemaV1.InferOutput<S[K]["value"]>>`. Non-durable types such as functions or `Buffer` map to `never`. `InferResourceTypes<S>` then computes the 10-field `ResourceTypes` object once:

```ts [packages/resource/src/resource.ts]
export type InferResourceTypes<S extends ResolvedSchema> = {
  params: Params<S>;
  compoundKey: CompoundKey<S>;
  primaryKey: ComputedPrimaryKey<S>;
  result: Result<S>;
  state: State<S>;
  output: Output<S>;
  collected: Contributions<S>;
  named: PhysicalNames<S>;
  credentials: Credentials<S>;
  created: CreateResult<S>;
};
```

Because `ResourceClass` and `Resource` are generic over `ResourceTypes` rather than the raw schema literal, downstream operations and dependency types never re-evaluate schema conditional types.

## Comparable parameters

`toComparableParams(schema, values)` extracts the parameters that participate in state diffing:

```ts [packages/resource/src/diff-params.ts]
export function toComparableParams(
  schema: Schema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const comparable: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (!isComparable(item)) continue;
    if (values[key] !== undefined) comparable[key] = values[key];
  }
  return comparable;
}
```

Only `propertyType === "param"` entries that are neither `volatile` nor `hidden` are kept, and `undefined` values are omitted because JSON state drops `undefined` properties.

`diffParams(schema, previous, desired, { canUpdate })` runs `toComparableParams` on both sides and normalizes kind mismatches before diffing via `deep-object-diff`. Any changed or unknown nested path is promoted to the whole top-level field in `patch`.

`diffParams` flags `replaceFields` (`{ name, known }`) whenever `!canUpdate || forcesReplacement(item)` (`immutable`, `primaryKey`, or `secondaryKey`). Display diffs convert `undefined` values to `null` via `toJsonSafe`.

## Unknown-after-apply sentinels

`UNKNOWN_AFTER_APPLY` is a JSON-safe structural sentinel used during planning for values that depend on an unapplied resource or a rotating credential:

```ts [packages/resource/src/diff-params.ts]
export const UNKNOWN_AFTER_APPLY = { $unknown: "after-apply" } as const;
```

`isUnknownAfterApply` checks `value !== null && typeof value === "object" && value.$unknown === "after-apply"`, while `containsUnknownAfterApply` searches arrays and objects recursively. Because planning replaces unresolved references at their exact paths, sibling fields inside a map or array stay visible.

In `diffParams`, any field with `containsUnknownAfterApply(desiredComparable[name])` is included in `changed` and `patch`. Any resulting `ParamReplaceField` is marked `known: false`.

## Kind-mismatch normalization

`deep-object-diff` compares arrays and plain objects by enumerable property keys. `{}` vs `[]` or `{ "0": "x" }` vs `["x"]` would otherwise diff as equal. Before calling `diff` or `detailedDiff`, `diffParams` and `changedKeys` pass `previous` through `nullKindChanges(previous, desired)`:

```ts [packages/resource/src/diff-params.ts]
function nullKindChanges(previous: unknown, desired: unknown): unknown {
  if (!isObject(previous) || !isObject(desired)) return previous;
  if (Array.isArray(previous) !== Array.isArray(desired)) return null;
  const copy: Record<string, unknown> = Array.isArray(previous)
    ? ([...previous] as unknown as Record<string, unknown>)
    : { ...previous };
  for (const [key, entry] of Object.entries(desired)) {
    if (key in previous) {
      copy[key] = nullKindChanges((previous as Record<string, unknown>)[key], entry);
    }
  }
  return copy;
}
```

Replacing any mismatched container in `previous` with `null` forces `deep-object-diff` to report `desired` as a clean update at that path with no spurious nested additions or deletions.

## Runtime validation points

`ValidationPoint` identifies the seven lifecycle stages where `validateValues` runs Standard Schema V1 validators:

| Point | Behavior |
| :--- | :--- |
| `declaration` | Validates `resource.config` inside the constructor |
| `plan` | Validates known resolved params via `validateParams` |
| `deploy` | Validates params before state mutation and before the operation |
| `create` | Validates the computed primary key and credentials returned by `create` |
| `rotate` | Validates the new secret returned by a `rotate` handler |
| `read` | Validates the result returned by `read` |
| `load` | Validates the secret loaded by a credential source's `loadCredential` |

At `declaration`, unknown refs and derived values are skipped and async validators queue into `pendingValidations`. At `plan` and `deploy`, `validateParams` receives `(subject, params, point, options)`.

Resources can attach per-param `checks?: { [K in keyof C]?: StandardSchemaV1 }` (`ParamChecks`). `validateValues` chains `subject.checks?.[field]` after `item.value` only at `CHECK_POINTS` (`declaration`, `plan`, `deploy`). It skips collected params at `declaration` (before contributions apply) and skips all checks when `validateParams` passes `partial: true` (for cycle placeholders), while `read` skips `ParamChecks` so drift plans as an update.

## Unknown-path filtering

When validating partial configs at `declaration` or `plan`, values may contain `OutputRef`, `Derived`, `UNKNOWN_AFTER_APPLY`, or `CredentialMarker` objects matched by `isUnknown`:

```ts [packages/resource/src/value-validation.ts]
function knownIssues(
  result: StandardSchemaV1.Result<unknown>,
  unknowns: Path[],
): readonly StandardSchemaV1.Issue[] {
  const issues = result.issues ?? [];
  if (unknowns.length === 0) return issues;
  return issues.filter((issue) => {
    const path = issuePath(issue);
    return !unknowns.some((unknown) => isPrefixEither(path, unknown));
  });
}
```

1. **Path discovery** – `findUnknownPaths(value, isUnknown)` traverses arrays and plain objects to collect every path matching `isUnknown`. If any unknown sits at the root (`path.length === 0`), the entire field is skipped.
2. **Safe execution** – when nested unknowns exist, `runValidator` executes the validator inside `try/catch` (and `.catch(() => ({ value }))` for async validators) so validators that coerce inputs to strings do not crash on marker objects.
3. **Prefix filtering** – `knownIssues` drops every issue whose `issuePath` is a prefix of an unknown path or vice versa (`isPrefixEither`). This suppresses issues on the unknown itself, inside it, and on ancestor objects or unions broken by the unknown child.

## Validation error redaction

`ValueValidationError` (`_tag = "ValueValidationError"`) formats each issue with `formatIssue(issue, sensitive)`. When `item.sensitive === true` or `item.propertyType === "credential"`, `formatIssue` replaces `issue.message` with `"Invalid sensitive value"` (keeping only the dotted field path prefix). Validator messages that embed the rejected value cannot leak secrets.

`SchemaStructureError` (`_tag = "SchemaStructureError"`) is thrown by `assertParamFields`, `assertRequiredParams`, `assertComputedFields`, `assertRequiredOutputs`, and `create` credential checks when fields are missing, unexpected, or invalid. It records only `resourceId`, `resourceType`, and `fields: string[]`, never values or raw validator messages.
