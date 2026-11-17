# Physical Names

`@notation/resource` scopes cloud resource names to an application and stage using `NameScope`. Deterministic names shorten with an FNV-1a hash, while generated names reserve space for random hex instance suffixes.

## Name scopes

A deployment's naming scope is represented by `NameScope`, and resource schema items with `physicalName` supply a `PhysicalNameRule`:

```ts [packages/resource/src/physical-name.ts]
export type NameScope = {
  app: string;
  stage: string;
};

export type PhysicalNameRule = {
  maxLength: number;
  ending?: (params: Record<string, unknown>) => string;
  base?: (resourceId: string) => string;
};
```

Because `app` and `stage` cannot contain `--` (enforced by `NameSafe` in `@notation/core`), the first `--` terminates `<app>` and the second `--` terminates `<stage>`. Two distinct `(app, stage)` pairs never collide.

## Deterministic names

`physicalName(scope, name, rule)` builds deterministic names for fixed-name resources:

1. Formats `full` as `${scope.app}--${scope.stage}--${name}` (or `name` if `scope` is `undefined`).
2. Returns `full` unchanged when `full.length <= rule.maxLength`.
3. Otherwise computes an 8-character lowercase hex 32-bit FNV-1a hash (`HASH_LENGTH = 8`, offset basis `0x811c9dc5`, prime `0x01000193`, zero-extended via `hash >>> 0`). This implementation avoids depending on `node:crypto`.

To keep the shortened name within `rule.maxLength`, `physicalName` reserves `HASH_LENGTH + 1` characters (`9` characters for `-${hash}`):

```ts [packages/resource/src/physical-name.ts]
const hash = fnv1a(full);
const room = rule.maxLength - HASH_LENGTH - 1;
if (room < 1) {
  throw new Error(
    `A maximum length of ${rule.maxLength} leaves no room for a shortened name`,
  );
}
const prefix = full.slice(0, room).replace(/[-_.]+$/, "");
return `${prefix}-${hash}`;
```

Trimming trailing `-`, `_`, and `.` from `prefix` avoids invalid double punctuation immediately before `-${hash}`.

## Generated names

Params with `physicalName` in their schema are omitted from `ConfigParams<T>`. Deploy generates a fresh `<app>--<stage>--<base>-<instance><ending>` name on every create or replace, enabling create-first replacement without collisions.

`GENERATED_INSTANCE_LENGTH` is `8`. The reconciler generates `instance` by encoding `GENERATED_INSTANCE_LENGTH / 2` (`4`) random bytes from `crypto.getRandomValues` into `8` lowercase hex characters.

`generatedPhysicalName(scope, resourceId, instance, rule, params)` computes the final name in two steps:

1. Evaluates `ending = rule.ending?.(params) ?? ""` (such as `".fifo"`).
2. Calls `generatedNameBody(scope, resourceId, rule, instance.length + 1 + ending.length)` so `suffixLength` reserves exact space for `-${instance}${ending}`.

Inside `generatedNameBody`, the base segment is normalized from `rule.base ? rule.base(resourceId) : resourceId`:

```ts [packages/resource/src/physical-name.ts]
const base = (rule.base ? rule.base(resourceId) : resourceId)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
const room = rule.maxLength - suffixLength;
if (room < 1) {
  throw new Error(
    `A maximum length of ${rule.maxLength} leaves no room for a generated name`,
  );
}
return `${scope.app}--${scope.stage}--${base}`.slice(0, room).replace(/-+$/, "");
```

Normalizing non-alphanumeric runs to single hyphens keeps `--` out of `<base>` and fits DNS-style lowercase character sets when `app`, `stage`, and `instance` do. Subtracting `suffixLength` before slicing guarantees `${body}-${instance}${ending}` never exceeds `rule.maxLength`, throwing if `room < 1`.

## Own-name markers

Because `physicalName` parameters are decided after `deriveParams` and parameter resolution, referencing a resource's own generated name via `resource.outputRef(field)` resolves to an `OwnPhysicalName` marker in `Resource.#resolveRefs`:

```ts [packages/resource/src/physical-name.ts]
export type OwnPhysicalName = { "~physicalName": string };

export function fillPhysicalNames(
  params: Record<string, unknown>,
  names: Record<string, unknown>,
): Record<string, unknown> {
  const fill = (value: unknown): unknown => {
    if (isOwnPhysicalName(value)) {
      const field = value["~physicalName"];
      if (!(field in names)) {
        throw new Error(`No name was given for ${field}`);
      }
      return names[field];
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, fill(entry)]),
      );
    }
    return value;
  };
  return { ...(fill(params) as Record<string, unknown>), ...names };
}
```

`OwnPhysicalName` is a plain JSON-serializable object so durable step checkpoints can record unresolved params before name generation runs.

`fillPhysicalNames(params, names)` recursively replaces every `{ "~physicalName": field }` marker inside arrays and plain objects with `names[field]` and merges `names` at the top level. At plan time, missing state names receive `UNKNOWN_AFTER_APPLY`; at deploy time, `names` supplies the generated or recovered physical name.
