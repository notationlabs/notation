import type {
  Schema,
  SchemaItem,
  SchemaFromApi,
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

export type { Schema, SchemaItem };

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
  read?: (key: any) => Promise<Result<any>>;
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
  S extends Schema = any,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = Params<S>,
> implements BaseResource
{
  config: C;
  id: string;
  groupId = -1;
  groupType = "";
  output = null as any as Output<S>;
  dependencies = {} as NoInfer<D>;
  abstract type: ResourceType;
  abstract schema: S;
  abstract create: (params: Params<S>) => Promise<ComputedPrimaryKey<S>>;
  abstract read?: (key: CompoundKey<S>) => Promise<Result<S>>;
  abstract update?: (
    key: CompoundKey<S>,
    patch: Params<S>,
    params: Params<S>,
    state: State<S>,
  ) => Promise<void>;
  abstract delete: (key: CompoundKey<S>, state: State<S>) => Promise<void>;
  abstract retryReadOnCondition?: ResultConditions<Output<S>>;
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

  get key() {
    const key = {} as CompoundKey<S>;
    for (const [k, v] of Object.entries(this.schema)) {
      const schemaItem = v as any;
      if (schemaItem.primaryKey || schemaItem.secondaryKey) {
        // @ts-expect-error - runtime mapping from schema
        key[k] = (this.output as any)[k];
      }
    }
    return key;
  }

  setOutput(output: Output<S>) {
    this.output = output as Output<S>;
  }

  toComparable(output: Output<S>) {
    const parsed = {} as Output<S>;
    for (const [k] of Object.entries(this.schema)) {
      if ((this.schema as any)[k].volatile) continue;
      if ((this.schema as any)[k].hidden) continue;
      if ((this.schema as any)[k].propertyType !== "param") continue;
      if (k in (output as any)) {
        // @ts-expect-error - runtime mapping from schema
        parsed[k] = (output as any)[k];
      }
    }
    return parsed;
  }

  toState(output: Output<S>) {
    const parsed = {} as Output<S>;
    for (const [k] of Object.entries(this.schema)) {
      if ((this.schema as any)[k].hidden) continue;
      if (k in (output as any)) {
        // @ts-expect-error - runtime mapping from schema
        parsed[k] = (output as any)[k];
      }
    }
    return parsed;
  }

  async getParams() {
    return {
      ...(this.config as any as Params<S>),
      ...(await this.deriveParams({
        id: this.id,
        config: this.config,
        deps: this.dependencies,
      })),
    } as any as Params<S>;
  }
}

export type DefineResourceMeta = { type: ResourceType };

export type DefineResourceApiSchema = {
  Key: any;
  CreateParams: any;
  UpdateParams: any;
  ReadResult: any;
};

export type ResourceOperationsOptions<
  S extends Schema,
  IntrinsicParams extends Partial<Params<S>>,
> = {
  create: (params: Params<S>) => Promise<ComputedPrimaryKey<S>>;
  read?: (key: CompoundKey<S>) => Promise<Result<S>>;
  update?: (
    key: CompoundKey<S>,
    patch: Params<S>,
    params: Params<S>,
    state: State<S>,
  ) => Promise<void>;
  delete: (key: CompoundKey<S>, state: State<S>) => Promise<void>;
  retryReadOnCondition?: ResultConditions<Output<S>>;
  failOnError?: (ErrorMatcher & { reason: string })[];
  notFoundOnError?: ErrorMatcher[];
  retryLaterOnError?: ErrorMatcher[];
  deriveParams?: (opts: {
    config: Partial<Params<S>>;
  }) => IntrinsicParams | Promise<IntrinsicParams>;
};

export type ResourceDependenciesBuilder<
  S extends Schema,
  IntrinsicParams extends Partial<Params<S>>,
  Dependencies extends Record<string, BaseResource | void>,
> = {
  deriveParams: <DepAwareParams extends Partial<Params<S>>>(
    deriveParams: (opts: {
      id: string;
      config: Params<S>;
      deps: Dependencies;
    }) => DepAwareParams | Promise<DepAwareParams>,
  ) => ResourceClass<
    S,
    Dependencies,
    Omit<Params<S>, keyof IntrinsicParams | keyof DepAwareParams>
  >;
};

export type ResourceClass<
  S extends Schema,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = Params<S>,
  IntrinsicParams extends Partial<Params<S>> = {},
> = {
  new (opts: ResourceOpts<C, D>): Resource<S, D, C>;
  readonly type: ResourceType;
  requireDependencies: <
    Dependencies extends Record<string, BaseResource | void>,
  >() => ResourceDependenciesBuilder<S, IntrinsicParams, Dependencies>;
};

export type ResourceSchemaBuilder<
  ApiSchema extends DefineResourceApiSchema,
  S extends SchemaFromApi<
    ApiSchema["Key"],
    ApiSchema["CreateParams"],
    Fallback<ApiSchema["UpdateParams"], ApiSchema["CreateParams"]>,
    Fallback<ApiSchema["ReadResult"], {}>
  >,
> = {
  defineOperations: <
    IntrinsicParams extends Partial<Params<S>> = {},
  >(
    opts: ResourceOperationsOptions<S, IntrinsicParams>,
  ) => ResourceClass<S, {}, Omit<Params<S>, keyof IntrinsicParams>, IntrinsicParams>;
};

export type ResourceBuilder<ApiSchema extends DefineResourceApiSchema> = {
  defineSchema: <
    S extends SchemaFromApi<
      ApiSchema["Key"],
      ApiSchema["CreateParams"],
      Fallback<ApiSchema["UpdateParams"], ApiSchema["CreateParams"]>,
      Fallback<ApiSchema["ReadResult"], {}>
    >,
  >(
    schema: S,
  ) => ResourceSchemaBuilder<ApiSchema, S>;
};

export function defineResource<ApiSchema extends DefineResourceApiSchema>(
  meta: DefineResourceMeta,
): ResourceBuilder<ApiSchema> {
  return {
    defineSchema<
      S extends SchemaFromApi<
        ApiSchema["Key"],
        ApiSchema["CreateParams"],
        Fallback<ApiSchema["UpdateParams"], ApiSchema["CreateParams"]>,
        Fallback<ApiSchema["ReadResult"], {}>
      >,
    >(schema: S): ResourceSchemaBuilder<ApiSchema, S> {
      return {
        defineOperations<IntrinsicParams extends Partial<Params<S>> = {}>(
          opts: ResourceOperationsOptions<S, IntrinsicParams>,
        ): ResourceClass<
          S,
          {},
          Omit<Params<S>, keyof IntrinsicParams>,
          IntrinsicParams
        > {
          class SimpleResource<
            D extends Record<string, BaseResource | void> = {},
            C extends Record<string, any> = Omit<Params<S>, keyof IntrinsicParams>,
          > extends Resource<S, NoInfer<D>, NoInfer<C>> {
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
                config: this.config as any as Partial<Params<S>>,
              });
            }

            static requireDependencies<
              Dependencies extends Record<string, BaseResource | void>,
            >() {
              return {
                deriveParams<DepAwareParams extends Partial<Params<S>>>(
                  deriveParams: (opts: {
                    id: string;
                    config: Params<S>;
                    deps: Dependencies;
                  }) => DepAwareParams | Promise<DepAwareParams>,
                ) {
                  return class DependencyAwareResource extends SimpleResource<
                    Dependencies,
                    Omit<
                      Params<S>,
                      keyof DepAwareParams | keyof IntrinsicParams
                    >
                  > {
                    async deriveParams() {
                      const superParams = await super.deriveParams();
                      return {
                        ...superParams,
                        ...(await deriveParams({
                          id: this.id,
                          config: this.config as Params<S>,
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
    },
  };
}

// Backwards-compatible alias (existing code uses `resource()`)
export const resource = defineResource;
