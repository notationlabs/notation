# Type System

`@notation/resource` carries Standard Schema validators, input reference wrappers, dependency unwrapping, and durability checks across `shared/`, `infra/`, and `runtime/` modules at compile time.

## Standard Schema

Notation validates resource parameters, read results, and handler payloads against [Standard Schema v1](https://standardschema.dev) (`StandardSchemaV1` in `@notation/resource`):

```ts [@notation/resource]
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["input"];

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}
```

Any validator library implementing `"~standard"` (`version: 1`) works directly, including Valibot, Zod, ArkType, and Effect Schema.

### Schema item constraints

In resource definitions, each `SchemaItem<T>` requires `value: StandardSchemaV1<T, T>`. Because Notation validates values without replacing them with the validator's output, both the validator's input type and output type must match `T` – validators that transform inputs or inject defaults do not compile as schema item validators.

## Input helpers

Resource configurations and contributions wrap parameter types recursively so callers can pass either literal values or reference tokens:

```ts [@notation/resource]
export type Input<T> = T | OutputRef<T> | Derived<T>;

export type DeepInput<T> = DeepInputWith<T, never>;

export type DeepInputWith<T, Also extends "credential" | "state"> =
  | OutputRef<T>
  | Derived<T>
  | ("credential" extends Also ? CredentialRef<T> : never)
  | ("state" extends Also ? (undefined extends T ? StateRef<T> : never) : never)
  | DeepInputMembers<T, Also>;
```

The three input type helpers accept literals or reference tokens:

| Type | Accepted values |
| :--- | :--- |
| `Input<T>` | Literal `T`, `OutputRef<T>`, or `Derived<T>` at one position |
| `DeepInput<T>` | Literal `T`, `OutputRef`, and `Derived` recursively at any depth |
| `DeepInputWith<T, Also>` | Recursive input optionally allowing `CredentialRef` or `StateRef` |

`DeepInput<T>` is equivalent to `DeepInputWith<T, never>`. `DeepInputWith<T, Also>` distributes across unions before mapping members, preserving function types verbatim while recursively wrapping object properties, arrays, and `readonly` arrays. Including `"credential"` in `Also` adds `CredentialRef<T>`, and including `"state"` adds `StateRef<T>` on members accepting `undefined` (`undefined extends T`).

### Config input

`ConfigInput<C>` types the `config` object passed to a `Resource` constructor:

```ts [@notation/resource]
export type ConfigInput<C> = {
  [K in keyof C]: DeepInputWith<C[K], "credential">;
};
```

Because `ConfigInput<C>` is a top-level mapped type, `config` itself cannot be replaced by an `OutputRef`, and `StateRef` tokens are rejected everywhere inside `config`.

### Contribution input

`ContributionInput<V>` types the argument to `resource.contribute(values)`:

```ts [@notation/resource]
export type ContributionInput<V> = {
  [K in keyof V]: DeepInputWith<V[K], "credential" | "state">;
};
```

Each collected parameter accepts literal values, `OutputRef`, `Derived`, `CredentialRef`, and (where `undefined` is permitted) `StateRef`.

## Resolution helpers

Handler signatures and runtime helpers unwrap reference and derived wrappers back to their resolved runtime types:

```ts [@notation/resource]
export type Resolved<T> = T extends
  OutputRef<infer V> | CredentialRef<infer V> | Derived<infer V>
  ? V
  : T;

export type ResolvedValues<T> = { [K in keyof T]: Resolved<T[K]> };
```

### Dependency resolution

`ResolvedDependency<R>` and `ResolvedDependencies<D>` type the `deps` object passed into `deriveParams`:

```ts [@notation/resource]
export type ResolvedDependency<R> = R extends {
  deriveParams(opts: { config: infer C }): unknown;
}
  ? Omit<R, "config"> & { readonly config: C }
  : R;

export type ResolvedDependencies<D> = {
  [K in keyof D]: ResolvedDependency<D[K]>;
};
```

`ResolvedDependency<R>` replaces the dependency's `ConfigInput` `config` property with its resolved `C` type and distributes over unions so optional dependencies (`Dep | undefined`) resolve cleanly.

## Partial helpers

Collected parameter rules use `DeepPartial<T>` and `DeepPartialValue<T>` to allow partial nested object contributions while keeping array elements complete:

```ts [@notation/resource]
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

Object properties become optional at every depth, while array element types remain non-optional so merged lists never introduce `undefined` items.

## Durability constraints

Because Notation persists resource parameters, read results, and state in SQLite across durable execution checkpoints, schema types enforce durability at compile time:

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

`ResolveSchema<S>` maps each schema item's `StandardSchemaV1.InferOutput` through `Durable<T>`. `Durable<T>` preserves primitives, `bigint`, `Date`, `Error`, arrays/tuples, `Map`/`Set`, and plain object properties, while mapping functions and class instances with methods (such as `Buffer`) to `never` so non-durable types fail to compile.

At runtime, values returned from `OutputRef.map(fn)` face stricter JSON-state recordability rules and reject promises/thenables, nested `OutputRef` or `Derived` values, `function`, `bigint`, `symbol`, and non-plain class instances. See [Types](../core/types.md) for boundary decoding examples.
