import type {
  DeepPartial,
  Fallback,
  OmitOptional,
  PickOptional,
  Simplify,
} from "./types";

/**
 * Structural holder for a value type.
 *
 * Used as a phantom type carrier: schema value types are resolved from the
 * resource's API schema, so items only carry metadata. Where a narrower type
 * than the API's is wanted, `valueType: typed<T>()` overrides it. Any zod
 * type is also structurally assignable, so zod validators can be used as
 * overrides without this package depending on zod.
 */
export type TypedValue<T> = { _output: T };

/**
 * Phantom value-type override for a schema item.
 * Purely type-level; carries no runtime information.
 */
export const typed = <T>(): TypedValue<T> => ({}) as TypedValue<T>;

export type DefineResourceApiSchema = {
  Key: any;
  CreateParams: any;
  UpdateParams: any;
  ReadResult: any;
};

/**
 * A schema item is metadata about one property of a resource.
 *
 * Its value type is taken from the resource's API schema (see
 * {@link ResolveSchema}); `valueType` is only needed to override that, or to
 * type properties that exist in no API type.
 */
export type SchemaItem<T = any> = {
  valueType?: TypedValue<T>;
  presence: "required" | "optional";
  sensitive?: true;
  hidden?: true;
  volatile?: true;
} & (
  | {
      propertyType: "param";
      immutable?: true;
      defaultValue?: T;
      primaryKey?: true;
      secondaryKey?: true;
    }
  | {
      propertyType: "computed";
      primaryKey?: true;
    }
  | {
      propertyType: "derived";
    }
);

/** A schema as authored: metadata per property. */
export type Schema = Record<string, SchemaItem<any>>;

/**
 * A schema whose items all carry a resolved value type.
 *
 * Deliberately loose (the mappers read `valueType` and the metadata flags
 * conditionally): schema safety is enforced where schemas are authored, via
 * {@link SchemaFromApi}, not in the type plumbing downstream of it.
 */
export type ResolvedSchema = Record<string, any>;

type UpdateParamsOf<Api extends DefineResourceApiSchema> = Fallback<
  Api["UpdateParams"],
  Api["CreateParams"]
>;

type ReadResultOf<Api extends DefineResourceApiSchema> = Fallback<
  Api["ReadResult"],
  {}
>;

/**
 * The value type of schema item `K`: an explicit `valueType` override wins,
 * otherwise the type comes from the API schema (params take precedence over
 * read results, since read results often widen param types).
 */
type SchemaItemValue<
  Api extends DefineResourceApiSchema,
  S extends Schema,
  K extends keyof S,
> = S[K] extends { valueType: TypedValue<infer T> }
  ? T
  : K extends keyof Api["CreateParams"]
    ? Exclude<Api["CreateParams"][K], undefined>
    : K extends keyof Api["Key"]
      ? Exclude<Api["Key"][K], undefined>
      : K extends keyof UpdateParamsOf<Api>
        ? Exclude<UpdateParamsOf<Api>[K], undefined>
        : K extends keyof ReadResultOf<Api>
          ? Exclude<ReadResultOf<Api>[K], undefined>
          : MissingValueType<K>;

/**
 * Marker for schema keys found in no API schema type and lacking a
 * `valueType` override. Deliberately unusable, so the mistake surfaces at
 * the first use of the property rather than silently typing it `unknown`.
 */
type MissingValueType<K> = {
  error: "Schema key not found in API schema types; add it there or set an explicit valueType";
  key: K;
};

/**
 * Pairs each schema item with its value type, resolved from the API schema.
 * Computed once per resource, when the schema is defined.
 */
export type ResolveSchema<
  Api extends DefineResourceApiSchema,
  S extends Schema,
> = {
  [K in keyof S]: S[K] & { valueType: TypedValue<SchemaItemValue<Api, S, K>> };
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
  { propertyType: "computed" | "derived" }
>;

export type Result<S extends ResolvedSchema> = DeepPartial<
  MapSchema<S, { propertyType: "param" | "derived" }>
>;

export type Output<S extends ResolvedSchema> = MapSchema<S>;

export type State<S extends ResolvedSchema> = MapSchema<S, { hidden: true }>;

/**
 * What a schema must look like for a given API schema: propertyType,
 * presence and mutability are forced per key by where (and how) the key
 * appears in the API types. A `valueType` override, when given, must stay
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
  [K in keyof OmitOptional<
    Omit<ApiCreateParams, keyof ApiCompoundKey>
  >]: SchemaItem<ApiCreateParams[K]> & {
    propertyType: "param";
    presence: "required";
  };
} & {
  [K in keyof PickOptional<
    Omit<ApiCreateParams, keyof ApiCompoundKey>
  >]: SchemaItem<ApiCreateParams[K]> & {
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
  [K in keyof Omit<
    ApiReadResult,
    keyof ApiCreateParams | keyof ApiCompoundKey
  >]: SchemaItem<ApiReadResult[K]> & {
    propertyType: "computed";
  };
};

/**
 * Maps `valueType` to its output type.
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
    [K in keyof S as S[K] extends { presence: "optional" } | ExcludeConditions
      ? never
      : IncludeKey extends keyof S[K]
        ? K
        : never]: S[K]["valueType"]["_output"];
  } & {
    [K in keyof S as S[K] extends ExcludeConditions
      ? never
      : S[K] extends { presence: "optional" }
        ? IncludeKey extends keyof S[K]
          ? K
          : never
        : never]?: S[K]["valueType"]["_output"];
  }
>;
