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
  Contributions,
} from "./resource.schema";
import type {
  OptionalIfAllPropertiesOptional,
  Fallback,
  NoInfer,
} from "./types";
import type { ResourceOperationContext } from "./resource-operation";
import type { DurableObject } from "./durable-value";
import { UNKNOWN_AFTER_APPLY, toComparableParams } from "./diff-params";
import {
  ContributionConflictError,
  captureCallSite,
  sortContributions,
  type CollectContext,
  type ContributeOptions,
  type ContributedValues,
  type Contribution,
  type ContributionFunction,
} from "./contributions";
import {
  OutputValue,
  OutputValueStringError,
  createPlanViews,
  deployLookup,
  forEachOutputValue,
  markUnknownOutputValues,
  planLookup,
  resolveOutputValues,
} from "./output-value";
import { getActiveResourceCollection } from "./resource-collection";

export type { Schema, SchemaItem, DefineResourceApiSchema };

export type ResourceType = `${string}/${string}/${string}`;

export type ResourceOpts<C, D> = OptionalIfAllPropertiesOptional<"config", C> &
  OptionalIfAllPropertiesOptional<"dependencies", D>;

/**
 * The arguments a resource takes after its ID. The options can be left out
 * when neither config nor dependencies has a required property.
 */
type ResourceArgs<C, D> =
  {} extends ResourceOpts<C, D>
    ? [opts?: ResourceOpts<C, D>]
    : [opts: ResourceOpts<C, D>];

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
  collected: any;
};

export type InferResourceTypes<S extends ResolvedSchema> = {
  params: Params<S>;
  compoundKey: CompoundKey<S>;
  primaryKey: ComputedPrimaryKey<S>;
  result: Result<S>;
  state: State<S>;
  output: Output<S>;
  collected: Contributions<S>;
};

/**
 * The config a resource takes: its params less `Omitted`. Collected params
 * are optional, because contributions can supply them.
 */
export type ConfigParams<
  T extends ResourceTypes,
  Omitted extends PropertyKey = never,
> = Omit<T["params"], Omitted | keyof T["collected"]> &
  Partial<
    Pick<
      T["params"],
      Exclude<keyof T["collected"], Omitted> & keyof T["params"]
    >
  >;

/**
 * Identifies the group a resource belongs to. A group's ID is unique among
 * groups of the same type.
 */
export type ResourceGroupRef = { type: string; id: string };

export interface BaseResource {
  readonly type: ResourceType;
  readonly schema: Schema;
  readonly config: any;
  id: string;
  /** The group the resource was added to, or null if it is in none. */
  group: ResourceGroupRef | null;
  readonly output: {};
  readonly dependencies: Record<string, BaseResource | void>;
  readonly key: {};
  keyOf(output: {}): {};
  create: (
    params: any,
    context?: ResourceOperationContext,
    token?: string,
  ) => Promise<{} | void>;
  find?: (params: any, token: string) => Promise<{} | void>;
  read?: (key: any, context?: ResourceOperationContext) => Promise<{}>;
  update?: (
    key: any,
    patch: any,
    params: any,
    state: any,
    context?: ResourceOperationContext,
  ) => Promise<void>;
  delete: (
    key: any,
    state: any,
    context?: ResourceOperationContext,
  ) => Promise<void>;
  getParams(): Promise<DurableObject>;
  toState(output: {}): {};
  toResult(result: {}): DurableObject;
  toComparable(output: {}): {};
  setOutput(result: {}): void;
  deriveParams?: (opts: {
    id: string;
    config: any;
    deps: any;
  }) => DurableObject | Promise<DurableObject>;
  /**
   * Adds values to the resource's collected params, or a function that
   * returns them from the outputs of `options.deps`. Throws once evaluation
   * has ended, or once the resource's params have been read.
   */
  contribute(values: {}, options?: ContributeOptions): void;
  contribute<Deps extends Record<string, BaseResource>>(
    compute: ContributionFunction<Deps, {}>,
    options: ContributeOptions & { deps: Deps },
  ): void;
  /**
   * Makes the resource depend on another after it was constructed. The same
   * lifetime rules apply as to `contribute`.
   */
  dependOn(resource: BaseResource): void;
  /**
   * Every resource this one depends on: its declared dependencies, those
   * added with `dependOn`, the deps of its function contributions, and the
   * resources whose output values its config and contributions hold.
   */
  getDependencies(): BaseResource[];
  /**
   * The params as a plan shows them. A value that holds an output not yet
   * deployed is `UNKNOWN_AFTER_APPLY` at its own path.
   */
  planParams(): Promise<Record<string, unknown>>;
  /** A token for one of the resource's outputs, to place whole in config. */
  outputValue(key: string): unknown;
}

export abstract class Resource<
  T extends ResourceTypes = ResourceTypes,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = T["params"],
> implements BaseResource {
  config: C;
  id: string;
  group: ResourceGroupRef | null = null;
  output = null as any as T["output"];
  dependencies = {} as NoInfer<D>;
  #collection = getActiveResourceCollection();
  #contributions: Contribution[] = [];
  #addedDependencies: BaseResource[] = [];
  // Set once the params or edges have been read. A contribution after that
  // would be left out of what was read.
  #sealed = false;
  abstract type: ResourceType;
  abstract schema: Schema;
  abstract create: (
    params: T["params"],
    context?: ResourceOperationContext,
    token?: string,
  ) => Promise<T["primaryKey"]>;
  find?: (params: T["params"], token: string) => Promise<T["primaryKey"]>;
  abstract read?: (
    key: T["compoundKey"],
    context?: ResourceOperationContext,
  ) => Promise<T["result"]>;
  abstract update?: (
    key: T["compoundKey"],
    patch: T["params"],
    params: T["params"],
    state: T["state"],
    context?: ResourceOperationContext,
  ) => Promise<void>;
  abstract delete: (
    key: T["compoundKey"],
    state: T["state"],
    context?: ResourceOperationContext,
  ) => Promise<void>;
  abstract deriveParams(opts: {
    id: string;
    config: C;
    deps: D;
  }): Record<string, any> | Promise<Record<string, any>>;

  constructor(
    id: string,
    { config, dependencies }: { config?: C; dependencies?: D } = {},
  ) {
    this.id = id;
    this.config = config || ({} as C);
    this.dependencies = dependencies || ({} as D);
    return this;
  }

  get key(): T["compoundKey"] {
    return this.keyOf(this.output);
  }

  keyOf(output: Partial<T["output"]>): T["compoundKey"] {
    const key = {} as Record<string, any>;
    for (const [k, v] of Object.entries<
      SchemaItem<any> & { primaryKey?: true; secondaryKey?: true }
    >(this.schema)) {
      if (v.primaryKey || v.secondaryKey) {
        key[k] = (output as any)[k];
      }
    }
    return key;
  }

  setOutput(output: T["output"]) {
    this.output = output;
  }

  toComparable(output: T["output"]): T["output"] {
    return toComparableParams(this.schema, output as Record<string, unknown>);
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

  /**
   * Copies the properties of a provider result that the schema declares.
   */
  toResult(result: {}): DurableObject {
    const declared = {} as DurableObject;
    for (const key of Object.keys(this.schema)) {
      if (key in result) declared[key] = (result as any)[key];
    }
    return declared;
  }

  /**
   * Returns a token for one of the resource's outputs, typed as the output.
   * Place it whole in config or in a contribution. The resource holding it
   * depends on this one, and the real value is filled in at deploy. Turning
   * it into a string throws: compute with the output in `deriveParams`, or
   * in a function contribution, which receive real outputs.
   */
  outputValue<K extends keyof T["output"] & string>(
    key: K,
  ): NonNullable<T["output"][K]> {
    return new OutputValue(this, [key]) as any;
  }

  contribute(values: T["collected"], options?: ContributeOptions): void;
  contribute<Deps extends Record<string, BaseResource>>(
    compute: ContributionFunction<Deps, T["collected"]>,
    options: ContributeOptions & { deps: Deps },
  ): void;
  contribute(
    input: unknown,
    options: ContributeOptions & { deps?: Record<string, BaseResource> } = {},
  ): void {
    const contributor =
      options.by ??
      captureCallSite(Resource.prototype.contribute) ??
      "an unknown call site";
    this.#assertOpen("contribute to");

    if (typeof input === "function") {
      this.#contributions.push({
        compute: input as ContributionFunction<any, Record<string, unknown>>,
        deps: options.deps ?? {},
        contributor,
      });
      return;
    }
    this.#contributions.push({
      values: this.#checkContribution(input as Record<string, unknown>),
      contributor,
    });
  }

  dependOn(resource: BaseResource): void {
    this.#assertOpen("add a dependency to");
    this.#addedDependencies.push(resource);
  }

  getDependencies(): BaseResource[] {
    this.#sealed = true;
    const found = new Set<BaseResource>();
    for (const dependency of Object.values(this.dependencies)) {
      if (dependency) found.add(dependency as BaseResource);
    }
    for (const dependency of this.#addedDependencies) found.add(dependency);
    const addToken = (token: OutputValue) => found.add(token.resource);
    forEachOutputValue(this.config, addToken);
    for (const contribution of this.#contributions) {
      if ("compute" in contribution) {
        for (const dependency of Object.values(contribution.deps)) {
          found.add(dependency);
        }
      } else {
        forEachOutputValue(contribution.values, addToken);
      }
    }
    return [...found];
  }

  async getParams(): Promise<T["params"]> {
    this.#sealed = true;
    const derivedParams = await this.deriveParams({
      id: this.id,
      config: this.config,
      deps: this.dependencies,
    });
    return this.#combineParams(derivedParams, false) as T["params"];
  }

  /**
   * At plan, `deriveParams` receives views of its dependencies. Reading the
   * output of a dependency that has none yet throws `PendingOutput`. When
   * `deriveParams` reads such an output, or throws, the plan cannot tell
   * which params are known: every param deriveParams would set, and every
   * param not set in config, is unknown. When it reads none, the plan is
   * exact.
   */
  async planParams(): Promise<Record<string, unknown>> {
    this.#sealed = true;
    const pending = this.getDependencies().some((dep) => dep.output == null);
    if (!pending) return withoutUndefined(await this.getParams());

    const views = createPlanViews();
    let derivedParams: Record<string, unknown>;
    try {
      derivedParams = await this.deriveParams({
        id: this.id,
        config: this.config,
        deps: views.of(this.dependencies),
      });
    } catch (error) {
      if (isMisuse(error)) throw error;
      return this.#cautiousPlanParams();
    }
    if (views.readPending) {
      return this.#cautiousPlanParams(Object.keys(derivedParams));
    }
    const params = this.#combineParams(derivedParams, true);
    return markUnknownOutputValues(withoutUndefined(params)) as Record<
      string,
      unknown
    >;
  }

  /**
   * @param derived Keys deriveParams returned. They are unknown even when
   * config also sets them, as the derived value replaces the config value.
   */
  #cautiousPlanParams(derived: string[] = []): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const config = this.config as Record<string, unknown>;
    const contributions = this.#evaluateContributions(true);
    for (const [key, item] of Object.entries(this.schema)) {
      if (item.propertyType === "computed") continue;
      if (derived.includes(key)) {
        params[key] = UNKNOWN_AFTER_APPLY;
        continue;
      }
      const value = item.collect
        ? this.#collect(key, item.collect, config[key], contributions, true)
        : resolveOutputValues(config[key], planLookup);
      params[key] =
        value === undefined ? UNKNOWN_AFTER_APPLY : markUnknownOutputValues(value);
    }
    return params;
  }

  #combineParams(
    derivedParams: Record<string, unknown>,
    plan: boolean,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      ...this.config,
      ...derivedParams,
    };
    const contributions = this.#evaluateContributions(plan);
    for (const [key, item] of Object.entries(this.schema)) {
      if (item.propertyType !== "param" || !item.collect) continue;
      params[key] = this.#collect(
        key,
        item.collect,
        params[key],
        contributions,
        plan,
      );
    }
    return resolveOutputValues(
      params,
      plan ? planLookup : deployLookup,
    ) as Record<string, unknown>;
  }

  /**
   * Runs function contributions. At deploy they receive their deps. At plan
   * they receive views of their deps, and one that reads an output not known
   * yet, or throws, leaves `unknown` set. Which params it would contribute to
   * is not known then, so every collected param is unknown.
   */
  #evaluateContributions(plan: boolean): EvaluatedContributions {
    const evaluated: EvaluatedContributions = { items: [], unknown: false };
    for (const contribution of this.#contributions) {
      if (!("compute" in contribution)) {
        evaluated.items.push(contribution);
        continue;
      }
      if (!plan) {
        const values = contribution.compute({ deps: contribution.deps });
        evaluated.items.push({
          values: this.#checkContribution(values),
          contributor: contribution.contributor,
        });
        continue;
      }
      const views = createPlanViews();
      let values: Record<string, unknown>;
      try {
        values = contribution.compute({ deps: views.of(contribution.deps) });
      } catch (error) {
        if (isMisuse(error)) throw error;
        evaluated.unknown = true;
        continue;
      }
      if (views.readPending) {
        evaluated.unknown = true;
        continue;
      }
      evaluated.items.push({
        values: this.#checkContribution(values),
        contributor: contribution.contributor,
      });
    }
    return evaluated;
  }

  /**
   * Combines a collected param's value from config with its contributions.
   * Output values are filled in first, so that `collect` compares real
   * values wherever they are known.
   */
  #collect(
    key: string,
    collect: (items: any[], context: CollectContext) => unknown,
    configured: unknown,
    contributions: EvaluatedContributions,
    plan: boolean,
  ): unknown {
    if (contributions.unknown) return UNKNOWN_AFTER_APPLY;
    const items = sortContributions(
      contributions.items
        .filter((contribution) => contribution.values[key] !== undefined)
        .map((contribution) => ({
          value: contribution.values[key],
          contributor: contribution.contributor,
        })),
      (item) => item.value,
    );
    if (configured !== undefined) {
      items.unshift({
        value: configured,
        contributor: `the config of ${this.id}`,
      });
    }
    if (items.length === 0) return undefined;
    const lookup = plan ? planLookup : deployLookup;
    return collect(
      items.map((item) => resolveOutputValues(item.value, lookup)),
      {
        resourceId: this.id,
        param: key,
        contributors: items.map((item) => item.contributor),
      },
    );
  }

  #checkContribution(values: Record<string, unknown>): Record<string, unknown> {
    const recorded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const item = this.schema[key];
      if (!item || item.propertyType !== "param" || !item.collect) {
        throw new Error(
          `Cannot contribute ${key} to ${this.id}: ${this.type} does not collect it`,
        );
      }
      if (value !== undefined) recorded[key] = value;
    }
    return recorded;
  }

  #assertOpen(action: string): void {
    const reason = this.#collection?.closed
      ? "evaluation has ended"
      : this.#sealed
        ? "its params have already been read"
        : undefined;
    if (!reason) return;
    throw new Error(
      `Cannot ${action} ${this.id}: ${reason}. Contributions are accepted only while infra is being evaluated.`,
    );
  }
}

type EvaluatedContributions = {
  items: ContributedValues[];
  // Set when a function contribution could not run at plan.
  unknown: boolean;
};

// Errors that deploy would also throw, so plan reports them instead of
// planning cautiously.
function isMisuse(error: unknown): boolean {
  return (
    error instanceof ContributionConflictError ||
    error instanceof OutputValueStringError
  );
}

function withoutUndefined(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

export type DefineResourceMeta = { type: ResourceType };

export type ResourceOperationsOptions<
  T extends ResourceTypes,
  IntrinsicParams extends Partial<T["params"]>,
> = {
  /**
   * Creates the resource. `token` is unique to the attempt. A resource that
   * defines `find` with a token records it on the remote resource, for
   * example as a tag.
   */
  create: (
    params: T["params"],
    context?: ResourceOperationContext,
    token?: string,
  ) => Promise<T["primaryKey"]>;
  /**
   * Finds the resource that a create attempt with `token` made, and returns
   * what that create would have returned. Throws `ResourceNotFoundError` when
   * the attempt made no resource.
   *
   * The reconciler calls it after a create attempt with an unknown outcome.
   * Without it, the reconciler reads a resource whose key is made of params,
   * and creates again a resource whose key the provider assigns.
   */
  find?: (params: T["params"], token: string) => Promise<T["primaryKey"]>;
  read?: (
    key: T["compoundKey"],
    context?: ResourceOperationContext,
  ) => Promise<T["result"]>;
  update?: (
    key: T["compoundKey"],
    patch: T["params"],
    params: T["params"],
    state: T["state"],
    context?: ResourceOperationContext,
  ) => Promise<void>;
  delete: (
    key: T["compoundKey"],
    state: T["state"],
    context?: ResourceOperationContext,
  ) => Promise<void>;
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
    ConfigParams<T, keyof IntrinsicParams | keyof DepAwareParams>
  >;
};

export type ResourceClass<
  T extends ResourceTypes,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = T["params"],
  IntrinsicParams extends Partial<T["params"]> = {},
> = {
  new (id: string, ...args: ResourceArgs<C, D>): Resource<T, D, C>;
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
    ConfigParams<T, keyof IntrinsicParams>,
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
          ConfigParams<T, keyof IntrinsicParams>,
          IntrinsicParams
        > {
          class SimpleResource<
            D extends Record<string, BaseResource | void> = {},
            C extends Record<string, any> = ConfigParams<
              T,
              keyof IntrinsicParams
            >,
          > extends Resource<T, NoInfer<D>, NoInfer<C>> {
            static type = meta.type;
            type = meta.type;
            schema = schema;
            create = opts.create;
            find = opts.find;
            read = opts.read ? opts.read : undefined;
            update = opts.update ? opts.update : undefined;
            delete = opts.delete;

            async deriveParams(_opts?: { deps: D }) {
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
                    ConfigParams<
                      T,
                      keyof DepAwareParams | keyof IntrinsicParams
                    >
                  > {
                    async deriveParams(opts?: { deps: Dependencies }) {
                      const superParams = await super.deriveParams();
                      return {
                        ...superParams,
                        ...(await deriveParams({
                          id: this.id,
                          config: this.config as T["params"],
                          deps: opts?.deps ?? this.dependencies,
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
