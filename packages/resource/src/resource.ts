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
  PhysicalNames,
} from "./resource.schema";
import type {
  OptionalIfAllPropertiesOptional,
  Fallback,
  NoInfer,
} from "./types";
import type {
  ResourceDeletion,
  ResourceOperationContext,
} from "./resource-operation";
import type { DurableObject } from "./durable-value";
import { UNKNOWN_AFTER_APPLY, toComparableParams } from "./diff-params";
import {
  captureCallSite,
  captureCallSiteLazily,
  sortContributions,
  type CollectContext,
  type ContributedValues,
  type Contribution,
  type ContributionFunction,
} from "./contributions";
import {
  OutputRef,
  createPlanViews,
  deployLookup,
  forEachOutputRef,
  hasPendingOutput,
  isOutputRef,
  markUnknownOutputRefs,
  planLookup,
  resolveOutputRefs,
  type PlanViews,
} from "./output-ref";
import { getActiveResourceCollection } from "./resource-collection";
import { assertParamFields, validateValues } from "./value-validation";

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
  named: any;
};

export type InferResourceTypes<S extends ResolvedSchema> = {
  params: Params<S>;
  compoundKey: CompoundKey<S>;
  primaryKey: ComputedPrimaryKey<S>;
  result: Result<S>;
  state: State<S>;
  output: Output<S>;
  collected: Contributions<S>;
  named: PhysicalNames<S>;
};

/**
 * The config a resource takes: its params less `Omitted` and less the params
 * with `physicalName`, which deploy generates. Collected params are
 * optional, because contributions can supply them.
 */
export type ConfigParams<
  T extends ResourceTypes,
  Omitted extends PropertyKey = never,
> = Omit<T["params"], Omitted | keyof T["collected"] | keyof T["named"]> &
  Partial<
    Pick<
      T["params"],
      Exclude<keyof T["collected"], Omitted | keyof T["named"]> &
        keyof T["params"]
    >
  >;

/**
 * Identifies the group a resource belongs to. A group's ID is unique among
 * groups of the same type.
 */
export type ResourceGroupRef = { type: string; id: string };

export interface BaseResource {
  readonly type: ResourceType;
  readonly provider: string;
  readonly schema: Schema;
  readonly config: any;
  id: string;
  /** `file:line` of the code that declared the resource, when known. */
  readonly declaredAt?: string;
  /** The group the resource was added to, or null if it is in none. */
  group: ResourceGroupRef | null;
  readonly output: {};
  readonly dependencies: Record<string, BaseResource | void>;
  readonly key: {};
  keyOf(output: {}): {};
  create: (
    params: any,
    context?: ResourceOperationContext,
  ) => Promise<{} | void>;
  find?: (params: any) => Promise<{}>;
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
    deletion?: ResourceDeletion,
  ) => Promise<void>;
  /** See `DefineResourceMeta.deleteTakesDependents`. */
  readonly deleteTakesDependents?: boolean;
  /** See `ResourceOperationsOptions.rejectChange`. */
  readonly rejectChange?: RejectChange<any>;
  /**
   * The params the resource deploys with. Deploy creates the placeholder of
   * a dependency cycle before the other members exist, so it leaves out the
   * contributions that depend on them.
   */
  getParams(options?: {
    /** Leaves out each contribution that depends on one of these. */
    excludeContributionsFrom?: ReadonlySet<BaseResource>;
  }): Promise<DurableObject>;
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
  contribute(values: {}): void;
  contribute<Deps extends Record<string, BaseResource>>(
    compute: ContributionFunction<Deps, {}>,
    options: { deps: Deps },
  ): void;
  /**
   * Makes the resource depend on another after it was constructed. Throws in
   * the same cases as `contribute`.
   */
  dependOn(resource: BaseResource): void;
  /**
   * Every resource this one depends on: its declared dependencies, those
   * added with `dependOn`, the deps of its function contributions, and the
   * resources whose output refs its config and contributions hold.
   */
  getDependencies(): BaseResource[];
  /**
   * The dependencies that do not come from contributions: the declared
   * dependencies, those added with `dependOn`, and the resources whose
   * output refs the config holds.
   */
  getFixedDependencies(): BaseResource[];
  /**
   * The collected params that contributions set, sorted. A function
   * contribution can set any collected param, so it counts as setting all
   * of them.
   */
  getContributedParams(options?: {
    /** Counts only the contributions that depend on one of these. */
    from?: ReadonlySet<BaseResource>;
  }): string[];
  /**
   * The params as a plan shows them. A value that holds an output not yet
   * deployed is `UNKNOWN_AFTER_APPLY` at its own path.
   */
  planParams(): Promise<Record<string, unknown>>;
  /** A token for one of the resource's outputs, to place whole in config. */
  outputRef(key: string): unknown;
}

export abstract class Resource<
  T extends ResourceTypes = ResourceTypes,
  D extends Record<string, BaseResource | void> = {},
  C extends Record<string, any> = T["params"],
> implements BaseResource {
  config: C;
  id: string;
  declare readonly declaredAt?: string;
  group: ResourceGroupRef | null = null;
  output = null as any as T["output"];
  dependencies = {} as NoInfer<D>;
  #collection = getActiveResourceCollection();
  #contributions: Contribution[] = [];
  #addedDependencies: BaseResource[] = [];
  // Set once code reads the params or dependencies. A later contribution
  // would be missing from what was read, so `contribute` throws.
  #sealed = false;
  abstract type: ResourceType;
  abstract provider: string;
  declare readonly deleteTakesDependents?: boolean;
  abstract schema: Schema;
  abstract create: (
    params: T["params"],
    context?: ResourceOperationContext,
  ) => Promise<T["primaryKey"]>;
  find?: (params: T["params"]) => Promise<T["primaryKey"] & {}>;
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
    deletion?: ResourceDeletion,
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
    const declaredAt = captureCallSiteLazily(new.target, {
      skipLibraryFrames: true,
    });
    // An own enumerable getter, so that a copy made with spread syntax keeps
    // the call site, as it would with a plain field.
    Object.defineProperty(this, "declaredAt", {
      get: declaredAt,
      enumerable: true,
    });
    return this;
  }

  /**
   * Checks config when the resource is declared: every field is a param, and
   * every value passes its validator. The outputs that output refs point at are not known yet, so
   * issues that they could cause are left to plan and deploy; see
   * `validateValues`. A subclass calls this at the end of its constructor,
   * when the schema has been set.
   *
   * An async validator cannot throw from the constructor. Its result is
   * awaited when the resource graph has been collected, and is otherwise
   * left to plan and deploy.
   */
  protected checkDeclaration(): void {
    if (this.#collection?.declarationChecks === false) return;
    const config = this.config as Record<string, unknown>;
    assertParamFields(this, config);
    const pending = validateValues(this, config, "declaration", isOutputRef);
    if (!pending) return;
    // Handled now, so that a rejection before collection awaits it is not
    // reported as unhandled. Collection still fails with it.
    pending.catch(() => {});
    if (this.#collection && !this.#collection.closed) {
      this.#collection.pendingValidations.push(pending);
    }
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
  outputRef<K extends keyof T["output"] & string>(
    key: K,
  ): NonNullable<T["output"][K]> {
    return new OutputRef(this, [key]) as any;
  }

  contribute(values: T["collected"]): void;
  contribute<Deps extends Record<string, BaseResource>>(
    compute: ContributionFunction<Deps, T["collected"]>,
    options: { deps: Deps },
  ): void;
  contribute(
    input: unknown,
    options: { deps?: Record<string, BaseResource> } = {},
  ): void {
    const contributor =
      captureCallSite(Resource.prototype.contribute) ?? "an unknown call site";
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
    const found = new Set(this.getFixedDependencies());
    for (const contribution of this.#contributions) {
      for (const dependency of contributionDependencies(contribution)) {
        found.add(dependency);
      }
    }
    return [...found];
  }

  getFixedDependencies(): BaseResource[] {
    this.#sealed = true;
    const found = new Set<BaseResource>();
    for (const dependency of Object.values(this.dependencies)) {
      if (dependency) found.add(dependency as BaseResource);
    }
    for (const dependency of this.#addedDependencies) found.add(dependency);
    forEachOutputRef(this.config, (token) => found.add(token.resource));
    return [...found];
  }

  getContributedParams({
    from,
  }: { from?: ReadonlySet<BaseResource> } = {}): string[] {
    this.#sealed = true;
    const params = new Set<string>();
    for (const contribution of this.#contributions) {
      if (from && !dependsOnAny(contribution, from)) continue;
      const keys =
        "compute" in contribution
          ? Object.keys(this.schema).filter(
              (key) =>
                this.schema[key]?.propertyType === "param" &&
                Boolean(this.schema[key].collect),
            )
          : Object.keys(contribution.values);
      for (const key of keys) params.add(key);
    }
    return [...params].sort();
  }

  async getParams({
    excludeContributionsFrom,
  }: { excludeContributionsFrom?: ReadonlySet<BaseResource> } = {}): Promise<
    T["params"]
  > {
    this.#sealed = true;
    const derivedParams = await this.deriveParams({
      id: this.id,
      config: this.config,
      deps: this.dependencies,
    });
    return (await this.#combineParams(derivedParams, {
      plan: false,
      excludeContributionsFrom,
    })) as T["params"];
  }

  /**
   * At plan, `deriveParams` receives views of its dependencies. Reading the
   * output of a dependency that has none yet, or a required output that is
   * missing from a dependency's output, throws `PendingOutput`. When
   * `deriveParams` reads such an output, the plan cannot tell which params
   * are known: every param not set in config is unknown. When it reads none,
   * the plan is exact.
   */
  async planParams(): Promise<Record<string, unknown>> {
    this.#sealed = true;
    const pending = this.getDependencies().some(hasPendingOutput);
    if (!pending) return withoutUndefined(await this.getParams());

    const views = createPlanViews();
    const derivedParams = await tryAtPlan(views, () =>
      this.deriveParams({
        id: this.id,
        config: this.config,
        deps: views.of(this.dependencies),
      }),
    );
    if (derivedParams === undefined) return this.#cautiousPlanParams();
    const params = await this.#combineParams(derivedParams, { plan: true });
    return markUnknownOutputRefs(withoutUndefined(params)) as Record<
      string,
      unknown
    >;
  }

  async #cautiousPlanParams(): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    const config = this.config as Record<string, unknown>;
    const contributions = await this.#evaluateContributions(true);
    for (const [key, item] of Object.entries(this.schema)) {
      if (item.propertyType === "computed") continue;
      const value = item.collect
        ? this.#collect(key, item.collect, config[key], contributions, true)
        : resolveOutputRefs(config[key], planLookup);
      params[key] =
        value === undefined
          ? UNKNOWN_AFTER_APPLY
          : markUnknownOutputRefs(value);
    }
    return params;
  }

  async #combineParams(
    derivedParams: Record<string, unknown>,
    options: {
      plan: boolean;
      excludeContributionsFrom?: ReadonlySet<BaseResource>;
    },
  ): Promise<Record<string, unknown>> {
    const { plan, excludeContributionsFrom } = options;
    const params: Record<string, unknown> = {
      ...this.config,
      ...derivedParams,
    };
    const contributions = await this.#evaluateContributions(
      plan,
      excludeContributionsFrom,
    );
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
    return resolveOutputRefs(
      params,
      plan ? planLookup : deployLookup,
    ) as Record<string, unknown>;
  }

  /**
   * Runs function contributions. At deploy each one receives its deps. At
   * plan each one receives views of its deps. When one reads an output that
   * does not exist yet, plan cannot tell which params it would set, so
   * `unknown` is set and `#collect` marks every collected param unknown.
   */
  async #evaluateContributions(
    plan: boolean,
    exclude?: ReadonlySet<BaseResource>,
  ): Promise<EvaluatedContributions> {
    const evaluated: EvaluatedContributions = { items: [], unknown: false };
    for (const contribution of this.#contributions) {
      if (exclude && dependsOnAny(contribution, exclude)) continue;
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
      const values = await tryAtPlan(views, () =>
        contribution.compute({ deps: views.of(contribution.deps) }),
      );
      if (values === undefined) {
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
   * Output refs are filled in first, so that `collect` compares real
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
      items.map((item) => resolveOutputRefs(item.value, lookup)),
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

/**
 * The deps of a function contribution, or the resources whose output refs
 * a contribution of values holds.
 */
function contributionDependencies(contribution: Contribution): BaseResource[] {
  if ("compute" in contribution) return Object.values(contribution.deps);
  const found: BaseResource[] = [];
  forEachOutputRef(contribution.values, (token) => found.push(token.resource));
  return found;
}

function dependsOnAny(
  contribution: Contribution,
  resources: ReadonlySet<BaseResource>,
): boolean {
  return contributionDependencies(contribution).some((dependency) =>
    resources.has(dependency),
  );
}

type EvaluatedContributions = {
  items: ContributedValues[];
  // Set when a function contribution read a pending output at plan.
  unknown: boolean;
};

// Runs code that reads dependency views. Returns undefined when the code read
// a pending output, whether it then returned or threw. Any other error is the
// code's own, and deploy would throw it too.
async function tryAtPlan<T>(
  views: PlanViews,
  run: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    const result = await run();
    return views.readPending ? undefined : result;
  } catch (error) {
    if (views.readPending) return undefined;
    throw error;
  }
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

export type DefineResourceMeta = {
  type: ResourceType;
  /**
   * The types of dependency that a resource of this type must be deleted
   * before, and created again after, when deploy replaces the dependency.
   * A type is listed in two cases:
   *
   * 1. The provider refuses to delete the dependency while the resource
   *    depends on it. For example, AWS does not delete an EventBridge bus
   *    that has rules, so the rule type lists `EventBus.type`.
   * 2. The provider removes the resource with the dependency, and creating
   *    the dependency again does not restore it. For example, a Lambda
   *    function's reserved concurrency is lost when the function is
   *    replaced under the same name, so `LambdaFunctionConcurrency` lists
   *    `LambdaFunction.type`.
   *
   * When deploy replaces a resource of a listed type, it first deletes each
   * resource of this type that depends on it in state. It then deletes the
   * resource, creates it again, and creates the dependents again. A
   * dependent of a type that does not list the type stays in place, and
   * deploy updates it when its params change.
   */
  blocksDeleteOf?: ResourceType[];
  /**
   * Set when `delete` uses its `deletion` argument. Deploy then lists state
   * before each delete of a resource of this type, to find the resources
   * that depend on it. Without it, `deletion` is undefined.
   */
  deleteTakesDependents?: boolean;
  /**
   * The package or package subpath that exports this class, such as
   * `@notation/aws/resources`. Stored in state, so the class can be loaded
   * after its type is removed from code.
   */
  provider: string;
};

/**
 * Returns a message to fail plan and deploy with, or `undefined` to allow
 * the change. `previous` holds the params in state, as they were recorded:
 * a record written before a param existed lacks that param, and state holds
 * no `hidden` param. `desired` holds the params in code, or is `undefined`
 * when deploy would delete the resource because it is no longer in code. At
 * plan, a value in `desired` that comes from an output that doesn't exist
 * yet is `UNKNOWN_AFTER_APPLY`. So is such a value in deploy's check before
 * the deployment hold, for a resource whose dependencies have no state.
 */
export type RejectChange<Params> = (
  previous: Partial<Params>,
  desired: Params | undefined,
  context: RejectChangeContext,
) => string | undefined;

export type RejectChangeContext = {
  /**
   * True when deploy deletes the resource and creates it again: a param
   * that forces replacement changed, or a resource that it depends on is
   * replaced and its type blocks that resource's delete.
   */
  replace: boolean;
};

export type ResourceOperationsOptions<
  T extends ResourceTypes,
  IntrinsicParams extends Partial<T["params"]>,
> = {
  /**
   * Creates the resource. Throws `ResourceAlreadyExistsError` when the
   * provider refuses the create because a resource with the same key exists.
   */
  create: (
    params: T["params"],
    context?: ResourceOperationContext,
  ) => Promise<T["primaryKey"]>;
  /**
   * Finds the resource that a create with `params` makes, and returns what
   * that create would have returned. A class defines it when the provider
   * assigns the key, or part of it.
   *
   * It must match on an attribute that is unique, such as a name. It throws
   * `ResourceNotFoundError` when no resource matches. When the provider does
   * not keep the attribute unique and several resources match, it throws an
   * error that names them, so that deploy never takes over one of several.
   *
   * Deploy calls it to get the key of a resource that it takes over, to look
   * up a create with an unknown outcome, and to delete the resource of a
   * "creating" record.
   */
  find?: (params: T["params"]) => Promise<T["primaryKey"] & {}>;
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
    deletion?: ResourceDeletion,
  ) => Promise<void>;
  deriveParams?: (opts: {
    config: Partial<T["params"]>;
  }) => IntrinsicParams | Promise<IntrinsicParams>;
  /**
   * Checks a change to a resource that has a state record, before deploy
   * changes anything. Plan and deploy call it for each such resource, and
   * for each resource of this type in state that is no longer in code.
   * `notation destroy` doesn't call it. Use it for a change that would lose
   * data, which a single param's `rejectReplace` can't see.
   */
  rejectChange?: RejectChange<T["params"]>;
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
  /** See `DefineResourceMeta.blocksDeleteOf`. */
  readonly blocksDeleteOf: readonly ResourceType[];
  readonly provider: string;
  /** See `ResourceOperationsOptions.rejectChange`. */
  readonly rejectChange?: RejectChange<T["params"]>;
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
  ) => ResourceSchemaBuilder<InferResourceTypes<ResolveSchema<S>>>;
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
    >(schema: S): ResourceSchemaBuilder<InferResourceTypes<ResolveSchema<S>>> {
      type T = InferResourceTypes<ResolveSchema<S>>;
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
            static provider = meta.provider;
            type = meta.type;
            static blocksDeleteOf = meta.blocksDeleteOf ?? [];
            deleteTakesDependents = meta.deleteTakesDependents ?? false;
            static rejectChange = opts.rejectChange;
            get rejectChange() {
              return SimpleResource.rejectChange;
            }
            provider = meta.provider;
            schema = schema;
            create = opts.create;
            find = opts.find;
            read = opts.read ? opts.read : undefined;
            update = opts.update ? opts.update : undefined;
            delete = opts.delete;

            constructor(
              id: string,
              args?: { config?: NoInfer<C>; dependencies?: NoInfer<D> },
            ) {
              super(id, args);
              this.checkDeclaration();
            }

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
        InferResourceTypes<ResolveSchema<S>>
      >;
    },
  };
}

// Backwards-compatible alias (existing code uses `resource()`)
export const resource = defineResource;

export function isResourceClass(
  value: unknown,
): value is ResourceClass<any, any, any> {
  return (
    typeof value === "function" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { provider?: unknown }).provider === "string"
  );
}
