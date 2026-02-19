import type { ZodType } from "zod";
import type {
  DeepPartial,
  FallbackIf,
  Intersect,
  OmitOptional,
  PickOptional,
} from "./types";

export type Schema = Record<string, SchemaItem<any>>;

export type SchemaItem<T> = {
  valueType: ZodType<T>;
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

export type ComputedPrimaryKey<S extends Schema> = FallbackIf<
  MapSchema<S, { propertyType: "param" }, "primaryKey">,
  {},
  void
>;

export type CompoundKey<S extends Schema> = MapSchema<
  S,
  never,
  "primaryKey" | "secondaryKey"
>;

export type Params<S extends Schema> = MapSchema<
  S,
  { propertyType: "computed" | "derived" }
>;

export type Result<S extends Schema> = DeepPartial<
  MapSchema<S, { propertyType: "param" | "derived" }>
>;

export type Output<S extends Schema> = MapSchema<S>;

export type State<S extends Schema> = MapSchema<S, { hidden: true }>;

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
 * Maps zod `valueType` to the output type.
 * Makes optional fields optional.
 * Excludes properties matching the `ExcludeConditions` type.
 */
export type MapSchema<
  S extends Schema,
  ExcludeConditions = never,
  ExcludeKey = any,
> = S extends {
  [K in keyof S]: { valueType: any };
}
  ? Intersect<
      {
        [K in keyof S as S[K] extends
          | { presence: "optional" }
          | ExcludeConditions
          ? never
          : ExcludeKey extends keyof S[K]
            ? K
            : never]: S[K]["valueType"]["_output"];
      },
      {
        [K in keyof S as S[K] extends { presence: "optional" }
          ? S[K] extends ExcludeConditions
            ? never
            : ExcludeKey extends keyof S[K]
               ? K
               : never
          : never]?: S[K]["valueType"]["_output"];
      }
    >
  : never;
