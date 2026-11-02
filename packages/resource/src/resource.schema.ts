import type {
  DeepPartial,
  OmitOptional,
  PickOptional,
  Simplify,
} from "./types";
import type { Durable } from "./durable-value";
import type { CollectContext } from "./contributions";
import type { StandardSchemaV1 } from "./standard-schema";

export type DefineResourceApiSchema = {
  Key: any;
  CreateParams: any;
  UpdateParams: any;
  ReadResult: any;
};

/**
 * A schema item describes one property of a resource: what it does in the
 * engine, and the validator for its value.
 */
export type SchemaItem<T = any> = {
  /**
   * Validates the property's value. Any Standard Schema can be used. Its
   * output type is the property's type, and must be assignable to the type
   * the resource's API schema gives the property.
   *
   * The engine checks values with the validator but keeps the values it was
   * given, not the validator's output. So the validator's input type must
   * also be assignable to the property's type, and a validator that
   * transforms its input does not compile. A default that a validator fills
   * in for an optional property is not applied either.
   */
  value: StandardSchemaV1<T, T>;
  presence: "required" | "optional";
  sensitive?: true;
  hidden?: true;
  volatile?: true;
} & (
  | {
      propertyType: "param";
      immutable?: true;
      primaryKey?: true;
      secondaryKey?: true;
      /**
       * Makes the param collected: any code can add to it with the
       * resource's `contribute`, and this rule combines what was added. The
       * items are the value set in config, if any, followed by every
       * contribution, sorted by content so that their order never depends
       * on the order code ran in. `collect` is not called when there are no
       * items.
       */
      collect?: (items: DeepPartial<T>[], context: CollectContext) => T;
    }
  | {
      propertyType: "computed";
      primaryKey?: true;
    }
);

/** A schema as authored: metadata per property. */
export type Schema = Record<string, SchemaItem<any>>;

/**
 * A schema whose items all carry a resolved value type.
 *
 * Deliberately loose (the mappers read `resolvedType` and the metadata flags
 * conditionally): schema safety is enforced where schemas are authored, via
 * {@link SchemaFromApi}, not in the type plumbing downstream of it.
 */
export type ResolvedSchema = Record<string, any>;

/**
 * Pairs each schema item with its value type, the output type of its
 * validator. Computed once per resource, when the schema is defined.
 *
 * The reconciler records params, read results and state, so each value type
 * is made durable here. A `Buffer` or another class instance in a validator's
 * output type becomes `never`, and a provider that returns one does not compile.
 */
export type ResolveSchema<S extends Schema> = {
  [K in keyof S]: S[K] & {
    /** Type-level only: no schema item has this property at runtime. */
    resolvedType: Durable<StandardSchemaV1.InferOutput<S[K]["value"]>>;
  };
};

export type ComputedPrimaryKey<S extends ResolvedSchema> = FallbackToVoid<
  MapSchema<S, { propertyType: "param" }, "primaryKey">
>;

type FallbackToVoid<T> = {} extends T ? void : T;

export type CompoundKey<S extends ResolvedSchema> = MapSchema<
  S,
  never,
  "primaryKey" | "secondaryKey"
>;

export type Params<S extends ResolvedSchema> = MapSchema<
  S,
  { propertyType: "computed" }
>;

export type Result<S extends ResolvedSchema> = DeepPartial<
  MapSchema<S, { propertyType: "param" }>
>;

export type Output<S extends ResolvedSchema> = MapSchema<S>;

/**
 * The values `contribute` accepts: one per collected param, typed as the
 * items its `collect` rule takes.
 */
export type Contributions<S extends ResolvedSchema> = {
  [
    K in keyof S as S[K] extends { collect: Function } ? K : never
  ]?: S[K] extends {
    collect: (items: (infer Item)[], ...rest: any[]) => any;
  }
    ? Item
    : never;
};

export type State<S extends ResolvedSchema> = MapSchema<S, { hidden: true }>;

/**
 * What a schema must look like for a given API schema: propertyType,
 * presence and mutability are forced per key by where (and how) the key
 * appears in the API types. The output type of each item's validator must be
 * assignable to the API's type for that key.
 */
export type SchemaFromApi<
  ApiCompoundKey,
  ApiCreateParams,
  ApiUpdateParams,
  ApiReadResult,
> = {
  [K in keyof ApiCompoundKey]: SchemaItem<ApiCompoundKey[K]> &
    ({ primaryKey: true } | { secondaryKey: true });
} & {
  [
    K in keyof OmitOptional<Omit<ApiCreateParams, keyof ApiCompoundKey>>
  ]: SchemaItem<ApiCreateParams[K]> & {
    propertyType: "param";
    presence: "required";
  };
} & {
  [
    K in keyof PickOptional<Omit<ApiCreateParams, keyof ApiCompoundKey>>
  ]: SchemaItem<ApiCreateParams[K]> & {
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
  [
    K in keyof Omit<ApiReadResult, keyof ApiCreateParams | keyof ApiCompoundKey>
  ]: SchemaItem<ApiReadResult[K]> & {
    propertyType: "computed";
  };
};

/**
 * Maps each item to its resolved value type.
 * Makes optional fields optional.
 * Excludes properties matching the `ExcludeConditions` type.
 * When `IncludeKey` is given, keeps only items that have that property.
 */
export type MapSchema<
  S extends ResolvedSchema,
  ExcludeConditions = never,
  IncludeKey = any,
> = Simplify<
  {
    [
      K in keyof S as S[K] extends { presence: "optional" } | ExcludeConditions
        ? never
        : IncludeKey extends keyof S[K]
          ? K
          : never
    ]: S[K]["resolvedType"];
  } & {
    [
      K in keyof S as S[K] extends ExcludeConditions
        ? never
        : S[K] extends { presence: "optional" }
          ? IncludeKey extends keyof S[K]
            ? K
            : never
          : never
    ]?: S[K]["resolvedType"];
  }
>;
