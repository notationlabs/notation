import type {
  Schema,
  SchemaItem,
  SchemaFromApi,
  ResolvedSchema,
  ResolveSchema,
  DefineResourceApiSchema,
  Params,
  Result,
  Output,
  State,
  ComputedPrimaryKey,
  CompoundKey,
} from "./resource.schema";
import type {
  OptionalIfAllPropertiesOptional,
  Fallback,
  NoInfer,
} from "./types";

export type { Schema, SchemaItem, DefineResourceApiSchema };

export type ResourceType = `${string}/${string}/${string}`;

export type ErrorMatcher = {
  name: string;
  message?: string;
  reason: string;
};

export type ResultCondition<T, K extends keyof T = keyof T> = {
  key: K;
  reason: string;
  value?: T[K];
};

export type ResultConditions<T> = {
  [K in keyof T]?: ResultCondition<T, K>;
}[keyof T][];

export type ResourceOpts<C, D> = OptionalIfAllPropertiesOptional<"config", C> &
  OptionalIfAllPropertiesOptional<"dependencies", D> & { id: string };

/**
 * The object types a resource's schema gives rise to.
 *
 * These are derived from the schema exactly once, when `defineSchema` is
 * called (see {@link InferResourceTypes}). Everything downstream — operation
 * callbacks, instances, dependency inference — is generic over this small
 * bag of plain object types, so the schema literal never re-enters type
 * inference.
 */
export type ResourceTypes = {
  params: any;
  compoundKey: any;
  primaryKey: any;
  result: any;
  state: any;
  output: any;
};

export type InferResourceTypes<S extends ResolvedSchema> = {
  params: Params<S>;
  compoundKey: CompoundKey<S>;
  primaryKey: ComputedPrimaryKey<S>;
  result: Result<S>;
  state: State<S>;
  output: Output<S>;
};

export interface BaseResource {
  readonly type: ResourceType;
  readonly schema: Schema;
  readonly config: any;
  id: string;
  groupId: number;
  groupType: string;
  readonly output: {};
  readonly dependencies: Record<string, BaseResource | void>;
  readonly retryReadOnCondition?: ({
    key: any;
    value?: any;
    reason: string;
  } | void)[];
  readonly failOnError?: (ErrorMatcher & { reason: string })[];
  readonly notFoundOnError?: ErrorMatcher[];
  readonly retryLaterOnError?: ErrorMatcher[];
  readonly key: {};
  create: (params: any) => Promise<{} | void>;
  read?: (key: any) => Promise<Record<string, any>>;
  update?: (key: any, patch: any, params: any, state: any) => Promise<void>;
  delete: (key: any, state: any) => Promise<void>;
  getParams(): Promise<{}>;
  toState(output: {}): {};
  toComparable(output: {}): {};
  setOutput(result: {}): void;
  deriveParams?: (opts: {
    id: string;
    config: any;
    deps: any;
  }) => Record<string, any> | Promise<Record<string, any>>;
}

export abstract class Resource<
  T extends ResourceTypes = ResourceTypes,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = T["params"],
> implements BaseResource {
  config: C;
  id: string;
  groupId = -1;
  groupType = "";
  output = null as any as T["output"];
  dependencies = {} as NoInfer<D>;
  abstract type: ResourceType;
  abstract schema: Schema;
  abstract create: (params: T["params"]) => Promise<T["primaryKey"]>;
  abstract read?: (key: T["compoundKey"]) => Promise<T["result"]>;
  abstract update?: (
    key: T["compoundKey"],
    patch: T["params"],
    params: T["params"],
    state: T["state"],
  ) => Promise<void>;
  abstract delete: (key: T["compoundKey"], state: T["state"]) => Promise<void>;
  abstract retryReadOnCondition?: ResultConditions<T["output"]>;
  abstract failOnError?: (ErrorMatcher & { reason: string })[];
  abstract notFoundOnError?: ErrorMatcher[];
  abstract retryLaterOnError?: ErrorMatcher[];
  abstract deriveParams(opts: {
    id: string;
    config: C;
    deps: D;
  }): Record<string, any> | Promise<Record<string, any>>;

  constructor(opts: ResourceOpts<C, D>) {
    this.id = opts.id;
    this.config = opts.config || ({} as C);
    this.dependencies = opts.dependencies || ({} as D);
    return this;
  }

  get key(): T["compoundKey"] {
    const key = {} as Record<string, any>;
    for (const [k, v] of Object.entries<
      SchemaItem<any> & { primaryKey?: true; secondaryKey?: true }
    >(this.schema)) {
      if (v.primaryKey || v.secondaryKey) {
        key[k] = (this.output as any)[k];
      }
    }
    return key;
  }

  setOutput(output: T["output"]) {
    this.output = output;
  }

  toComparable(output: T["output"]): T["output"] {
    const parsed = {} as Record<string, any>;
    for (const [k, v] of Object.entries(this.schema)) {
      if (v.volatile) continue;
      if (v.hidden) continue;
      if (v.propertyType !== "param") continue;
      if (k in (output as any)) {
        parsed[k] = (output as any)[k];
      }
    }
    return parsed;
  }

  toState(output: T["output"]): T["state"] {
    const parsed = {} as Record<string, any>;
    for (const [k, v] of Object.entries(this.schema)) {
      if (v.hidden) continue;
      if (k in (output as any)) {
        parsed[k] = (output as any)[k];
      }
    }
    return parsed;
  }

  async getParams(): Promise<T["params"]> {
    return {
      ...this.config,
      ...(await this.deriveParams({
        id: this.id,
        config: this.config,
        deps: this.dependencies,
      })),
    };
  }
}

export type DefineResourceMeta = { type: ResourceType };

export type ResourceOperationsOptions<
  T extends ResourceTypes,
  IntrinsicParams extends Partial<T["params"]>,
> = {
  create: (params: T["params"]) => Promise<T["primaryKey"]>;
  read?: (key: T["compoundKey"]) => Promise<T["result"]>;
  update?: (
    key: T["compoundKey"],
    patch: T["params"],
    params: T["params"],
    state: T["state"],
  ) => Promise<void>;
  delete: (key: T["compoundKey"], state: T["state"]) => Promise<void>;
  retryReadOnCondition?: ResultConditions<T["output"]>;
  failOnError?: (ErrorMatcher & { reason: string })[];
  notFoundOnError?: ErrorMatcher[];
  retryLaterOnError?: ErrorMatcher[];
  deriveParams?: (opts: {
    config: Partial<T["params"]>;
  }) => IntrinsicParams | Promise<IntrinsicParams>;
};

export type ResourceDependenciesBuilder<
  T extends ResourceTypes,
  IntrinsicParams extends Partial<T["params"]>,
  Dependencies extends Record<string, BaseResource | void>,
> = {
  deriveParams: <DepAwareParams extends Partial<T["params"]>>(
    deriveParams: (opts: {
      id: string;
      config: T["params"];
      deps: Dependencies;
    }) => DepAwareParams | Promise<DepAwareParams>,
  ) => ResourceClass<
    T,
    Dependencies,
    Omit<T["params"], keyof IntrinsicParams | keyof DepAwareParams>
  >;
};

export type ResourceClass<
  T extends ResourceTypes,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = T["params"],
  IntrinsicParams extends Partial<T["params"]> = {},
> = {
  new (opts: ResourceOpts<C, D>): Resource<T, D, C>;
  readonly type: ResourceType;
  requireDependencies: <
    Dependencies extends Record<string, BaseResource | void>,
  >() => ResourceDependenciesBuilder<T, IntrinsicParams, Dependencies>;
};

export type ResourceSchemaBuilder<T extends ResourceTypes> = {
  defineOperations: <IntrinsicParams extends Partial<T["params"]> = {}>(
    opts: ResourceOperationsOptions<T, IntrinsicParams>,
  ) => ResourceClass<
    T,
    {},
    Omit<T["params"], keyof IntrinsicParams>,
    IntrinsicParams
  >;
};

export type ResourceBuilder<ApiSchema extends DefineResourceApiSchema> = {
  defineSchema: <
    S extends Schema &
      SchemaFromApi<
        ApiSchema["Key"],
        ApiSchema["CreateParams"],
        Fallback<ApiSchema["UpdateParams"], ApiSchema["CreateParams"]>,
        Fallback<ApiSchema["ReadResult"], {}>
      >,
  >(
    schema: S,
  ) => ResourceSchemaBuilder<InferResourceTypes<ResolveSchema<ApiSchema, S>>>;
};

export function defineResource<ApiSchema extends DefineResourceApiSchema>(
  meta: DefineResourceMeta,
): ResourceBuilder<ApiSchema> {
  return {
    defineSchema<
      S extends Schema &
        SchemaFromApi<
          ApiSchema["Key"],
          ApiSchema["CreateParams"],
          Fallback<ApiSchema["UpdateParams"], ApiSchema["CreateParams"]>,
          Fallback<ApiSchema["ReadResult"], {}>
        >,
    >(
      schema: S,
    ): ResourceSchemaBuilder<InferResourceTypes<ResolveSchema<ApiSchema, S>>> {
      type T = InferResourceTypes<ResolveSchema<ApiSchema, S>>;
      // The cast skips re-relating this literal to ResourceSchemaBuilder:
      // defineOperations restates the declared signature verbatim, and
      // structurally verifying the deferred conditionals inside it costs
      // ~350ms of check time in every program that includes this file.
      const builder = {
        defineOperations<IntrinsicParams extends Partial<T["params"]> = {}>(
          opts: ResourceOperationsOptions<T, IntrinsicParams>,
        ): ResourceClass<
          T,
          {},
          Omit<T["params"], keyof IntrinsicParams>,
          IntrinsicParams
        > {
          class SimpleResource<
            D extends Record<string, BaseResource | void> = {},
            C extends Record<string, any> = Omit<
              T["params"],
              keyof IntrinsicParams
            >,
          > extends Resource<T, NoInfer<D>, NoInfer<C>> {
            static type = meta.type;
            type = meta.type;
            schema = schema;
            create = opts.create;
            read = opts.read ? opts.read : undefined;
            update = opts.update ? opts.update : undefined;
            delete = opts.delete;
            retryReadOnCondition = opts.retryReadOnCondition;
            failOnError = opts.failOnError;
            notFoundOnError = opts.notFoundOnError;
            retryLaterOnError = opts.retryLaterOnError;

            async deriveParams() {
              if (!opts.deriveParams) return {};
              return await opts.deriveParams({
                config: this.config as any as Partial<T["params"]>,
              });
            }

            static requireDependencies<
              Dependencies extends Record<string, BaseResource | void>,
            >() {
              return {
                deriveParams<DepAwareParams extends Partial<T["params"]>>(
                  deriveParams: (opts: {
                    id: string;
                    config: T["params"];
                    deps: Dependencies;
                  }) => DepAwareParams | Promise<DepAwareParams>,
                ) {
                  return class DependencyAwareResource extends SimpleResource<
                    Dependencies,
                    Omit<
                      T["params"],
                      keyof DepAwareParams | keyof IntrinsicParams
                    >
                  > {
                    async deriveParams() {
                      const superParams = await super.deriveParams();
                      return {
                        ...superParams,
                        ...(await deriveParams({
                          id: this.id,
                          config: this.config as T["params"],
                          deps: this.dependencies,
                        })),
                      };
                    }
                  };
                },
              };
            }
          }

          return SimpleResource as any;
        },
      };
      return builder as ResourceSchemaBuilder<
        InferResourceTypes<ResolveSchema<ApiSchema, S>>
      >;
    },
  };
}

// Backwards-compatible alias (existing code uses `resource()`)
export const resource = defineResource;
