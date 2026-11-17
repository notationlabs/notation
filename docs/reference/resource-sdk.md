# Resource SDK

`@notation/resource` provides the type-safe builder API, schema contract, lifecycle operations, dependency wiring, and error classes used to author custom infrastructure resources. See [Resources](../authoring/resources.md) for a step-by-step authoring walkthrough.

## Resource builder

Define a resource class in three chained calls starting from `defineResource<ApiSchema>(meta)` (also exported as `resource`).

### `defineResource`

`defineResource` returns a `ResourceBuilder` whose `.defineSchema(schema)` and `.defineOperations(opts)` calls produce an instantiable `ResourceClass`:

```ts [@notation/resource]
export function defineResource<ApiSchema extends DefineResourceApiSchema>(
  meta: DefineResourceMeta,
): ResourceBuilder<ApiSchema>;

export const resource = defineResource;

export type DefineResourceApiSchema = {
  Key: any;
  CreateParams: any;
  UpdateParams: any;
  ReadResult: any;
};
```

Calling `defineResource(meta)` without `<ApiSchema>` skips compile-time checks against an external SDK type. Pass `as const` when passing a standalone schema variable to `.defineSchema(schema)` so TypeScript preserves literal modifier flags.

### `isResourceClass`

`isResourceClass(value)` narrows an unknown value to `ResourceClass<any, any, any>` across installed package copies by checking that `value` is a function with string `type` and `provider` properties:

```ts [@notation/resource]
export function isResourceClass(
  value: unknown,
): value is ResourceClass<any, any, any>;
```

## Resource metadata

`DefineResourceMeta` sets the resource identity, package resolution path, and reconciler ordering flags:

```ts [@notation/resource]
export type ResourceType = `${string}/${string}/${string}`;

export type DefineResourceMeta = {
  type: ResourceType;
  provider: string;
  blocksDeleteOf?: ResourceType[];
  deleteTakesDependents?: boolean;
  replaceCreatesFirst?: boolean;
  readLagsCreate?: boolean;
};
```

Each metadata field controls a specific reconciler behavior:

| Property | Description |
| :--- | :--- |
| `type` | Unique three-segment identifier such as `"acme/webhooks/WebhookEndpoint"` |
| `provider` | Package or subpath specifier exporting the resource class |
| `blocksDeleteOf` | Dependency types this resource must delete before and recreate after during delete-first replacement |
| `deleteTakesDependents` | Passes `{ dependents }` as the fourth argument to `delete` |
| `replaceCreatesFirst` | Replaces create-first without `physicalName` when each creation yields a distinct key |
| `readLagsCreate` | Retries `ResourceNotFoundError` from post-create `read` calls for eventually consistent providers |

`provider` must never be a relative path so orphan cleanup can load the class after removal from code. `blocksDeleteOf` defaults to `[]`, and all three boolean flags default to `false` (see [Recovery](../internals/recovery.md) for `readLagsCreate` retry behavior).

## Schema definition

`.defineSchema(schema)` maps each property name to a `SchemaItem<T>` with a `propertyType` role, a Standard Schema validator, and optional modifiers.

### `SchemaFromApi`

When `<ApiSchema>` is provided to `defineResource<ApiSchema>(meta)`, `SchemaFromApi` validates your schema against `Key`, `CreateParams`, `UpdateParams` (defaulting to `CreateParams`), and `ReadResult` (defaulting to `{}`):

```ts [@notation/resource]
export type SchemaFromApi<
  ApiCompoundKey,
  ApiCreateParams,
  ApiUpdateParams,
  ApiReadResult,
> = {
  [K in keyof ApiCompoundKey]: SchemaItem<ApiCompoundKey[K]> &
    ({ primaryKey: true } | { secondaryKey: true });
} & {
  [K in keyof OmitOptional<Omit<ApiCreateParams, keyof ApiCompoundKey>>]:
    SchemaItem<ApiCreateParams[K]> & {
      propertyType: "param";
      presence: "required";
    };
} & {
  [K in keyof PickOptional<Omit<ApiCreateParams, keyof ApiCompoundKey>>]:
    SchemaItem<ApiCreateParams[K]> & {
      propertyType: "param";
      presence: "optional";
    };
} & {
  [K in keyof Omit<ApiCreateParams, keyof ApiUpdateParams>]: SchemaItem<
    ApiCreateParams[K]
  > & {
    propertyType: "param";
    immutable: true;
  };
} & {
  [K in keyof Omit<ApiReadResult, keyof ApiCreateParams | keyof ApiCompoundKey>]:
    SchemaItem<ApiReadResult[K]> & {
      propertyType: "computed";
    };
};
```

`SchemaFromApi` enforces four compile-time invariants:

- **Compound keys** – Keys in `Key` must declare `primaryKey: true` or `secondaryKey: true` (a key in `Key` absent from `CreateParams` uses `propertyType: "computed"` with `primaryKey: true`).
- **Presence parity** – Keys in `CreateParams` outside `Key` must match optionality with `presence: "required"` or `presence: "optional"`.
- **Immutability** – Keys in `CreateParams` absent from `UpdateParams` must set `immutable: true`.
- **Computed outputs** – Keys in `ReadResult` outside `CreateParams | Key` must use `propertyType: "computed"`.

### Property roles

Every `SchemaItem<T>` specifies one of three `propertyType` roles:

| Role | Description |
| :--- | :--- |
| `"param"` | Configuration input supplied via `config`, `deriveParams`, or `contribute` |
| `"computed"` | Remote output returned by `create` or `read` |
| `"credential"` | Secret returned by `create` or `rotate` and read via `.credentials` |

Both `"param"` and `"computed"` items require `presence: "required" | "optional"`. A `"computed"` field is returned by `create` when `primaryKey: true` and by `read` otherwise; `"credential"` fields stay in memory and are passed to dependents via `resource.credentials.<name>`.

### Schema validation

Each item's `value` field takes a `StandardSchemaV1<T, T>` validator whose input and output types both equal `T`:

```ts [@notation/resource]
export type SchemaItem<T = any> = {
  value: StandardSchemaV1<T, T>;
  sensitive?: true;
  hidden?: true;
  volatile?: true;
} & (
  | {
      propertyType: "param";
      presence: "required" | "optional";
      immutable?: true;
      primaryKey?: true;
      secondaryKey?: true;
      rejectReplace?: (previous: T, desired: T) => string;
      collect?(items: CollectItem<T>[], context: CollectContext): T;
      physicalName?: PhysicalNameRule;
    }
  | {
      propertyType: "computed";
      presence: "required" | "optional";
      primaryKey?: true;
    }
  | {
      propertyType: "credential";
    }
);
```

Because Notation preserves original values rather than validator outputs, transforming validators or schema-level defaults do not compile. Compute default values in `deriveParams` instead. Instances can also supply per-field `checks?: { [K in keyof C]?: StandardSchemaV1 }` in constructor options to validate inputs at declaration, `plan`, and `deploy` without affecting drift reads (see [Validation](../internals/validation.md)).

## Schema modifiers

Modifiers refine how Notation keys, diffs, persists, names, validates, and protects individual schema items:

| Modifier | Description |
| :--- | :--- |
| `presence` | Marks `"param"` or `"computed"` items `"required"` or `"optional"` |
| `immutable` | Forces replacement on `"param"` changes instead of `update` |
| `primaryKey` | Includes a `"param"` or `"computed"` property in `CompoundKey` |
| `secondaryKey` | Includes an additional `"param"` in `CompoundKey` |
| `physicalName` | Generates a scoped name and omits the param from `ConfigParams` |
| `collect` | Makes a `"param"` optional in `config` and enables `contribute()` |
| `rejectReplace` | Fails `plan` and `deploy` with a returned message if a param change forces replacement |
| `hidden` | Excludes a field from state records and diffing while still passing it to `create` and `update` |
| `sensitive` | Masks validator error messages with `"Invalid sensitive value"` while keeping the field path |
| `volatile` | Persists a field in state records while excluding it from param diffing |

Missing required `"param"` fields fail validation before `plan` and `deploy`, while missing required `"computed"` outputs after `read` or `create` throw `SchemaStructureError`. Changing any `primaryKey` or `secondaryKey` param forces replacement; a `"computed"` `primaryKey` must be returned by `create` and triggers `find` during takeover or recovery. Properties with `propertyType: "credential"` are always treated as `sensitive`.

### `physicalName`

Valid on `"param"` (`PhysicalNameRule`). Marks the param as an engine-generated scoped name (`<app>--<stage>--<base>-<instance><ending>`) and omits it from `ConfigParams`:

```ts [@notation/resource]
export type PhysicalNameRule = {
  maxLength: number;
  ending?: (params: Record<string, unknown>) => string;
  base?: (resourceId: string) => string;
};
```

Resources with a `physicalName` param replace create-first with a new instance suffix, and dependents reference the name via `resource.outputRef("<param>")`. Setting a `physicalName` field in untyped `config` or `deriveParams` fails validation (see [Physical Names Reference](./physical-names.md)).

### `collect`

Valid on `"param"` (`(items: CollectItem<T>[], context: CollectContext) => T`). Makes the param optional in `config` (even when `presence: "required"`) and enables `resource.contribute(values)` during infra evaluation:

```ts [@notation/resource]
export type CollectContext = {
  resourceId: string;
  param: string;
  contributors: (() => string)[];
};

export function mergeContributions<T>(
  items: DeepPartial<T>[],
  context: CollectContext,
): T;
```

Notation puts `config[key]` first when set, sorts contributed items deterministically, resolves known refs, and invokes `collect(items, context)` only when at least one item exists. Use `mergeContributions` to recursively merge plain-object maps and raise `ContributionConflictError` on conflicting leaf paths.

## Durability rules

All params, read results, and state records must be serializable as `DurableValue`:

```ts [@notation/resource]
export type DurableValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | bigint
  | Date
  | Error
  | readonly DurableValue[]
  | ReadonlyMap<DurableValue, DurableValue>
  | ReadonlySet<DurableValue>
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };
```

`ResolveSchema<S>` wraps each validator output type in `Durable<T>`. Primitives, `Date`, `Error`, arrays, tuples, `Map`, `Set`, plain objects, and interfaces remain intact, whereas `Function` and class instances with methods (such as `Buffer`) evaluate to `never` so non-serializable values fail at compile time.

## Resource groups

Extend `ResourceGroup<C>` from `@notation/resource` to organize related resources or nested groups under a single logical construct:

```ts [@notation/resource]
export type ResourceGroupId = { type: string; id: string };

export type ResourceGroupRef = ResourceGroupId & {
  parents: ResourceGroupId[];
};

export abstract class ResourceGroup<
  C extends Record<string, any> = Record<string, any>,
> {
  readonly type: string;
  readonly id: string;
  readonly config: C;
  readonly resources: BaseResource[];
  readonly groups: ResourceGroup[];
  constructor(type: string, id: string, config?: C);
  get parent(): ResourceGroupRef | null;
  get ref(): ResourceGroupRef;
  add<T extends BaseResource | ResourceGroup>(member: T): T;
  addOnce<T extends new (id: string, ...args: any[]) => BaseResource>(
    ResourceClass: T,
    id: string,
    ...args: T extends new (id: string, ...args: infer A) => any ? A : never
  ): InstanceType<T>;
}
```

Every `(type, id)` pair must be unique within the active deployment graph.

### Properties

| Property | Description |
| :--- | :--- |
| `type` | Group type identifier |
| `id` | Deployment-unique group identifier |
| `config` | Constructor config object |
| `resources` | Direct child resources registered in this group |
| `groups` | Direct child groups registered in this group |
| `parent` | Immediate parent `ResourceGroupRef` or `null` for a top-level group |
| `ref` | `ResourceGroupRef` containing `{ type, id, parents }` |

`config` defaults to `{}`. `ref.parents` is ordered from the outermost ancestor down to the immediate parent.

### Methods

- **`add(member)`** – Attaches a `BaseResource` or child `ResourceGroup` to this group and registers it in the active graph if not already present. Throws if the resource or group already belongs to a group, or if adding the group creates a cycle.
- **`addOnce(ResourceClass, id, ...args)`** – Returns an existing resource in `this.resources` matching `id` (throwing if its constructor differs from `ResourceClass`), or constructs and adds a new instance.

## Dependencies

Resources declare intrinsic parameter derivation inside `.defineOperations(...)` and typed dependency derivation on the resulting `ResourceClass`.

### Operation `deriveParams`

Pass `deriveParams({ config })` to `.defineOperations(...)` to compute intrinsic params from `config` alone:

```ts [@notation/resource]
deriveParams?: (opts: {
  config: Partial<T["params"]>;
}) => IntrinsicParams | Promise<IntrinsicParams>;
```

Keys in `IntrinsicParams` are automatically omitted from `ConfigParams`.

### `requireDependencies`

Call `.requireDependencies<Dependencies>()` on a `ResourceClass` returned by `.defineOperations(...)` to declare typed constructor `dependencies` and chain a dependency-aware `.deriveParams(...)`:

```ts [@notation/resource]
requireDependencies: <
  Dependencies extends Record<string, BaseResource | void>,
>() => ResourceDependenciesBuilder<T, IntrinsicParams, Dependencies>;
```

### Dependency `deriveParams`

`.deriveParams(fn)` on `ResourceDependenciesBuilder` receives `{ id, config, deps }` and returns `DepAwareParams` (which merges on top of any operation-level `deriveParams` result and omits its keys from `ConfigParams`):

```ts [@notation/resource]
deriveParams: <DepAwareParams extends Partial<T["params"]>>(
  deriveParams: (opts: {
    id: string;
    config: T["params"];
    deps: ResolvedDependencies<Dependencies>;
  }) => DepAwareParams | Promise<DepAwareParams>,
) => ResourceClass<
  T,
  Dependencies,
  ConfigParams<T, keyof IntrinsicParams | keyof DepAwareParams>
>;
```

During `plan`, reading an unresolved ref or missing dependency output inside `deriveParams` marks all params not directly set in `config` as unknown until apply. Reading a `physicalName` field or credential inside `config` throws in both `plan` and `deploy`.

### `ResolvedDependencies`

`ResolvedDependencies<D>` maps each dependency `R` through `ResolvedDependency<R>`, distributing over unions so optional dependencies retain resolved `config` fields and omit private members:

```ts [@notation/resource]
export type ResolvedDependencies<D> = {
  [K in keyof D]: ResolvedDependency<D[K]>;
};

export type ResolvedDependency<R> = R extends {
  deriveParams(opts: { config: infer C }): unknown;
}
  ? Omit<R, "config"> & { readonly config: C }
  : R;
```

Use `ResolvedDependency<MyResourceInstance>` when typing standalone helper functions that accept `deps.<name>`. Dependency views passed at runtime delegate `outputRef()`, `credentials`, and `~state` to the real resource, though strict `===` identity checks and private fields differ.

## Lifecycle operations

`.defineOperations(opts)` implements required and optional lifecycle handlers along with change guards. Several handlers accept an optional `ResourceOperationContext` (`Readonly<DurableObject>`), which receives `callbackContext` from a previous `ResourceOperationPendingError`.

### `create`

Required. Provisions the remote resource and returns `CreateResult<S>` (any computed `primaryKey` fields and all `"credential"` properties, or `void` when neither exists):

```ts [@notation/resource]
create: (
  params: T["params"],
  context?: ResourceOperationContext,
) => Promise<T["created"]>;
```

Throw `ResourceAlreadyExistsError` when a colliding resource already exists at the provider, or `ResourceCreationUnknownError` when creation may have succeeded (such as after a request timeout).

### `read`

Optional. Observes the current remote resource state for drift detection, takeover, and recovery:

```ts [@notation/resource]
read?: (
  key: T["compoundKey"],
  context?: ResourceOperationContext,
  params?: T["params"],
) => Promise<T["result"]>;
```

Throw `ResourceNotFoundError` when the resource does not exist. Resources without `read` cannot detect drift or be adopted on takeover.

### `update`

Optional. Applies in-place changes to mutable params:

```ts [@notation/resource]
update?: (
  key: T["compoundKey"],
  patch: T["params"],
  params: T["params"],
  state: T["state"],
  context?: ResourceOperationContext,
) => Promise<void>;
```

`patch` holds changed comparable params, `params` holds all desired params, and `state` holds the prior state record. Referenced credentials appear in `patch` and `params` only when their version changed relative to `state` (and are `undefined` otherwise), so omit `undefined` credential fields before sending full payloads. Omitting `update` turns any comparable param change into a replacement.

### `delete`

Required. Deletes the remote resource and succeeds cleanly if it is already absent:

```ts [@notation/resource]
export type ResourceDeletion = {
  dependents: readonly {
    id: string;
    type: string;
    params: Readonly<Record<string, unknown>>;
  }[];
};

delete: (
  key: T["compoundKey"],
  state: T["state"],
  context?: ResourceOperationContext,
  deletion?: ResourceDeletion,
) => Promise<void>;
```

`deletion` is populated only when `DefineResourceMeta.deleteTakesDependents` is `true`.

### `find`

Optional. Looks up an existing resource by unique attributes in `params` and returns its computed `primaryKey` when the provider assigns the key:

```ts [@notation/resource]
find?: (params: T["params"]) => Promise<T["primaryKey"] & {}>;
```

Throw `ResourceNotFoundError` when no resource matches, and throw an error listing matching candidates if the provider permits duplicates.

### `rotate`

Optional. Map of rotation functions keyed by `"credential"` property name:

```ts [@notation/resource]
export type RotateOperations<T extends ResourceTypes> = {
  [K in keyof T["credentials"]]?: (
    key: T["compoundKey"],
    state: T["state"],
  ) => Promise<T["credentials"][K]>;
};
```

Notation invokes `rotate[name]` when a new or updated consumer needs the credential and the process holds no plaintext value, or when operators pass `--credential`.

### `rotateManually`

Optional. Map of single-sentence instructions (`{ [K in keyof T["credentials"]]?: string }`) displayed in `UnobtainableCredentialError` above `--credential` and `--replace` guidance when no `rotate` handler exists for that credential.

### `rejectChange`

Optional operation-level guard (`RejectChange<T["params"]>`) checked during `plan` and `deploy` (but not `notation destroy`) for existing resources and orphan deletions:

```ts [@notation/resource]
export type RejectChange<Params> = (
  previous: Partial<Params>,
  desired: Params | undefined,
  context: RejectChangeContext,
) => string | undefined;

export type RejectChangeContext = {
  replace: boolean;
  requested?: true;
};
```

`desired` is `undefined` when the resource was removed from code. Return an error message to block the change or `undefined` to allow it; operators can bypass `rejectChange` with `--override-loss-protection <id>` when `context.requested` is `true` (see [CLI Flags](./cli-flags.md)).

## Operation errors

`@notation/resource` exports typed error classes used by lifecycle handlers and contribution merging.

### `ResourceNotFoundError`

Thrown by `read`, `find`, or `delete` when no matching remote resource exists:

```ts [@notation/resource]
export class ResourceNotFoundError extends Error {
  readonly _tag = "ResourceNotFoundError" as const;
  constructor(message: string, options?: ErrorOptions);
  static is(error: unknown): error is ResourceNotFoundError;
}
```

### `ResourceAlreadyExistsError`

Thrown by `create` when the provider rejects creation because a resource with the same key or unique name already exists, triggering takeover:

```ts [@notation/resource]
export class ResourceAlreadyExistsError extends Error {
  readonly _tag = "ResourceAlreadyExistsError" as const;
  constructor(message: string, options?: ErrorOptions);
  static is(error: unknown): error is ResourceAlreadyExistsError;
}
```

### `ResourceCreationUnknownError`

Thrown by `create` when the outcome is uncertain (such as a network timeout), prompting Notation to look up the resource before retrying `create`:

```ts [@notation/resource]
export class ResourceCreationUnknownError extends Error {
  readonly _tag = "ResourceCreationUnknownError" as const;
  constructor(message: string, options?: ErrorOptions);
  static is(error: unknown): error is ResourceCreationUnknownError;
}
```

### `ResourceOperationPendingError`

Thrown by `create`, `read`, `update`, or `delete` when an asynchronous provider operation has not completed yet:

```ts [@notation/resource]
export class ResourceOperationPendingError extends Error {
  readonly _tag = "ResourceOperationPendingError" as const;
  readonly retryAfterMs: number;
  readonly callbackContext?: ResourceOperationContext;
  readonly throttled: boolean;
  constructor(
    message: string,
    options: ErrorOptions & {
      retryAfterMs: number;
      callbackContext?: ResourceOperationContext;
      throttled?: boolean;
    },
  );
  static is(error: unknown): error is ResourceOperationPendingError;
}
```

`retryAfterMs` must be a finite non-negative number (throws `RangeError` otherwise). Set `throttled: true` on rate limits so `read` throttling is not misinterpreted as absence.

### `ContributionConflictError`

Thrown by `mergeContributions` when two contributors (or `config` and a contribution) set the same leaf path to different values:

```ts [@notation/resource]
export class ContributionConflictError extends Error {
  readonly resourceId: string;
  readonly path: string;
  readonly contributors: [string, string];
  constructor(
    resourceId: string,
    path: string,
    contributors: [string, string],
    values: [unknown, unknown],
  );
}
```
