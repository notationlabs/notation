import type { BaseResource } from "./resource";
import type { Schema } from "./resource.schema";
import type { DurableObject } from "./durable-value";
import { UNKNOWN_AFTER_APPLY, isUnknownAfterApply } from "./diff-params";
import { captureCallSiteLazily } from "./contributions";
import { isOwnPhysicalName } from "./physical-name";
import { isCredentialMarker } from "./credential";

export class OutputRefStringError extends Error {
  /**
   * @param subject Names the value, such as `Output orders.QueueArn`.
   * @param noun What the value is, such as `an output ref`.
   */
  constructor(subject: string, noun = "an output ref") {
    super(
      `${subject}: ${noun} can't be turned into a string. Place it whole, join it with text\`…\`, or compute with it in map().`,
    );
    this.name = "OutputRefStringError";
  }
}

// Marks an output ref and a derived value. `isOutputRef` and `isDerived`
// check the mark and not the class, because a project can load two copies of
// this package.
const outputRefBrand: unique symbol = Symbol.for(
  "@notation/resource/OutputRef",
);
const derivedBrand: unique symbol = Symbol.for("@notation/resource/Derived");

type RefKind = "output" | "credential" | "state";

// The members of every kind of ref. `~value` holds `T` for the type checker
// only. Without it, nothing in a `CredentialRef` or a `StateRef` reads `T`,
// and a ref of one type would fit a ref of any other.
interface RefMembers<T, K extends RefKind> {
  readonly [outputRefBrand]: true;
  readonly kind: K;
  readonly "~value"?: () => T;
  readonly resource: BaseResource;
  readonly path: readonly string[];
}

/**
 * Stands for an output of a resource, which deploy fills in. Place it whole
 * in config or in a contribution, join it with `text`, or compute with it in
 * `map`. Turning it into a string throws, because the string would not hold
 * the value.
 */
export interface OutputRef<T = unknown> extends RefMembers<T, "output"> {
  /**
   * Computes a value from the output. Plan calls `fn` when the output is
   * known, and deploy calls it with the output. `fn` must depend only on its
   * argument, and must return a value that state can record: not a promise,
   * and no ref or derived value at any depth.
   */
  map<U>(fn: (value: T) => U): Derived<U>;
}

/**
 * Stands for a credential of a resource. It can only be placed whole: a value
 * computed from it would be recorded in state as a plain param.
 */
export interface CredentialRef<T = unknown> extends RefMembers<
  T,
  "credential"
> {}

/**
 * Stands for an output in the state record of a resource, which is
 * undefined when there is no record. Made by `resource["~state"].outputRef`.
 * It adds no dependency, and it can only be placed whole in a contribution.
 */
export interface StateRef<T = unknown> extends RefMembers<
  T | undefined,
  "state"
> {}

export type AnyOutputRef = OutputRef | CredentialRef | StateRef;

/**
 * The value that deploy fills in for `T`: the value of a ref, a credential or
 * a derived value, and `T` itself otherwise. It doesn't recurse into objects.
 */
export type Resolved<T> = T extends
  OutputRef<infer V> | CredentialRef<infer V> | Derived<infer V>
  ? V
  : T;

/** A value, or a ref or a derived value that deploy fills in with one. */
export type Input<T> = T | OutputRef<T> | Derived<T>;

/**
 * `Input` at each level of an object or array. The refs are added to the
 * whole of `T` before it is split into the members of a union, so that
 * `DeepInput<boolean>` takes an `OutputRef<boolean>`.
 */
export type DeepInput<T> = DeepInputWith<T, never>;

/**
 * `DeepInput`, which also takes a `CredentialRef` or a `StateRef` at each
 * level when `Also` names it.
 */
export type DeepInputWith<T, Also extends "credential" | "state"> =
  | OutputRef<T>
  | Derived<T>
  | ("credential" extends Also ? CredentialRef<T> : never)
  | ("state" extends Also ? StateRef<T> : never)
  | DeepInputMembers<T, Also>;

// Distributes over a union, so each object in it is mapped on its own. An
// array is written as an array type, which the type checker expands only
// when it is read, so a recursive type such as a JSON value ends.
type DeepInputMembers<
  T,
  Also extends "credential" | "state",
> = T extends readonly (infer E)[]
  ? T extends unknown[]
    ? DeepInputWith<E, Also>[]
    : readonly DeepInputWith<E, Also>[]
  : T extends Function
    ? T
    : T extends object
      ? { [K in keyof T]: DeepInputWith<T[K], Also> }
      : T;

// Turning a ref or a derived value into a string throws, because the string
// would not hold the value.
abstract class Unstringable {
  protected abstract stringError(): OutputRefStringError;

  [Symbol.toPrimitive](): never {
    throw this.stringError();
  }

  toString(): never {
    throw this.stringError();
  }

  toJSON(): never {
    throw this.stringError();
  }
}

class OutputRefClass extends Unstringable {
  readonly [outputRefBrand] = true as const;

  constructor(
    readonly resource: BaseResource,
    readonly path: readonly string[],
    readonly kind: RefKind = "output",
  ) {
    super();
  }

  map(fn: (value: unknown) => unknown): Derived {
    const callSite = captureCallSiteLazily(OutputRefClass.prototype.map, {
      skipLibraryFrames: true,
    });
    assertDerivable(this as AnyOutputRef, () => `map() at ${site(callSite)}`);
    return mapDerived(this as AnyOutputRef, fn, callSite);
  }

  protected stringError(): OutputRefStringError {
    return new OutputRefStringError(`Output ${describeOutputRef(this)}`);
  }
}

/**
 * The class of every ref. `kind` tells an output, a credential and a
 * `~state` ref apart, without reading the resource.
 */
export const OutputRef = OutputRefClass as {
  new <T = unknown>(
    resource: BaseResource,
    path: readonly string[],
    kind?: "output",
  ): OutputRef<T>;
  new <T = unknown>(
    resource: BaseResource,
    path: readonly string[],
    kind: "credential",
  ): CredentialRef<T>;
  new <T = unknown>(
    resource: BaseResource,
    path: readonly string[],
    kind: "state",
  ): StateRef<T>;
  readonly prototype: AnyOutputRef;
};

/**
 * The outputs of the targets of `~state` refs, from their state records at
 * the start of the deploy or plan. Each target has an entry, which is null
 * when the target has no full record. When the deploy replaces a target, its
 * entry still holds the outputs from before the replace.
 */
export type RecordedOutputs = { [id: string]: DurableObject | null };

/**
 * Makes a `~state` ref. Throws unless only a replace changes the output: a
 * param that is `immutable`, `primaryKey` or `secondaryKey`, or that has
 * `physicalName`. An output that an update changes would be read one
 * deploy late, with no error. Also throws for a `hidden` param, which the
 * state record does not hold, so the ref would always resolve to undefined.
 */
export function stateOutputRef<T = unknown>(
  resource: BaseResource,
  key: string,
): StateRef<T> {
  const item = resource.schema[key];
  if (item?.propertyType === "param" && item.hidden) {
    throw new Error(
      `Cannot read ${key} of ${resource.id} from state: it is a hidden param, which the state record does not hold`,
    );
  }
  const readable =
    item?.propertyType === "param" &&
    (item.immutable ||
      item.primaryKey ||
      item.secondaryKey ||
      item.physicalName);
  if (!readable) {
    throw new Error(
      `Cannot read ${key} of ${resource.id} from state: ~state can read only an output that only a replace changes, which is a param that is immutable, primaryKey or secondaryKey, or that has physicalName`,
    );
  }
  return new OutputRef<T>(resource, [key], "state");
}

/**
 * Finds `~state` refs in `recorded`. A ref whose target has no record
 * resolves to undefined.
 */
export function recordedLookup(
  recorded: RecordedOutputs | undefined,
): OutputLookup {
  return (token) => {
    const { id } = token.resource;
    if (!recorded || !(id in recorded)) {
      throw new Error(
        `Output ${describeOutputRef(token)} is read from state, but the outputs in state were not read for ${id}. Make each ~state ref while infra is evaluated.`,
      );
    }
    return { known: true, value: readPath(recorded[id], token.path) };
  };
}

/**
 * Whether a ref is from `owner` to its own `physicalName` param. Deploy
 * fills such a ref in when it fills in the name, so it is no dependency.
 */
export function isOwnNameRef(
  owner: BaseResource,
  token: AnyOutputRef,
): boolean {
  if (token.resource !== owner || token.path.length !== 1) return false;
  const item = owner.schema[token.path[0]!];
  return item?.propertyType === "param" && Boolean(item.physicalName);
}

/** Whether the holder of `token` depends on the resource it names. */
export function isDependencyRef(
  holder: BaseResource,
  token: AnyOutputRef,
): boolean {
  return !isStateRef(token) && !isOwnNameRef(holder, token);
}

/**
 * Finds the value an output ref stands for. `known: false` means the
 * output does not exist yet, so the value stays a token.
 */
export type OutputLookup = (
  token: AnyOutputRef,
) => { known: true; value: unknown } | { known: false };

export function isOutputRef(value: unknown): value is AnyOutputRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [outputRefBrand]?: unknown })[outputRefBrand] === true
  );
}

export function isCredentialRef(value: unknown): value is CredentialRef {
  return isOutputRef(value) && value.kind === "credential";
}

export function isStateRef(value: unknown): value is StateRef {
  return isOutputRef(value) && value.kind === "state";
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isDerived(value: unknown): value is Derived {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [derivedBrand]?: unknown })[derivedBrand] === true
  );
}

/**
 * Walks a value and calls `visit` for every output ref in it, including
 * each ref that a derived value reads.
 */
export function forEachOutputRef(
  value: unknown,
  visit: (token: AnyOutputRef) => void,
): void {
  if (isOutputRef(value)) return visit(value);
  if (isDerived(value)) {
    for (const input of value["~inputs"]) forEachOutputRef(input, visit);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) forEachOutputRef(entry, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) forEachOutputRef(entry, visit);
  }
}

/**
 * Whether a value holds an output ref. A derived value that reads no ref is
 * not found.
 */
export function containsOutputRef(value: unknown): boolean {
  let found = false;
  forEachOutputRef(value, () => {
    found = true;
  });
  return found;
}

const isRefOrDerived = (value: unknown): boolean =>
  isOutputRef(value) || isDerived(value);

/** Whether a value holds an output ref or a derived value. */
export function containsRefOrDerived(value: unknown): boolean {
  return containsMatch(value, isRefOrDerived);
}

// Whether `matches` holds for the value, or for a value in the arrays and
// plain objects in it.
function containsMatch(
  value: unknown,
  matches: (value: unknown) => boolean,
): boolean {
  if (matches(value)) return true;
  const entries = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.values(value)
      : [];
  return entries.some((entry) => containsMatch(entry, matches));
}

/**
 * Copies a value, replacing every output ref in it with the result of
 * `onToken`, and every derived value with the result of `onDerived`.
 */
function mapRefs(
  value: unknown,
  onToken: (token: AnyOutputRef) => unknown,
  onDerived: (derived: Derived) => unknown,
): unknown {
  if (isOutputRef(value)) return onToken(value);
  if (isDerived(value)) return onDerived(value);
  if (Array.isArray(value)) {
    return value.map((entry) => mapRefs(entry, onToken, onDerived));
  }
  if (isPlainObject(value)) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      mapped[key] = mapRefs(entry, onToken, onDerived);
    }
    return mapped;
  }
  return value;
}

/**
 * Replaces every output ref that `lookup` knows with its value, and computes
 * every derived value whose refs `lookup` knows. Refs and derived values
 * that `lookup` does not know are left in place.
 */
export function resolveOutputRefs(
  value: unknown,
  lookup: OutputLookup,
): unknown {
  return mapRefs(
    value,
    (token) => {
      const found = lookup(token);
      return found.known ? found.value : token;
    },
    (derived) => {
      const found = resolveDerived(derived, lookup);
      return found.known ? found.value : derived;
    },
  );
}

/**
 * Finds output refs in the resource's output. The output must exist: a
 * resource holding an output ref depends on the resource it came from, so
 * that resource has been deployed first.
 */
export const deployLookup: OutputLookup = (token) => {
  const output = token.resource.output as Record<string, unknown> | null;
  if (output == null) {
    throw new Error(
      `Output ${describeOutputRef(token)} was read before ${token.resource.id} was deployed`,
    );
  }
  return { known: true, value: readPath(output, token.path) };
};

/**
 * Finds output refs in the resource's output when it has one, such as the
 * output a plan reads from state, and leaves the rest unknown. A required
 * output that the output lacks is unknown too.
 */
export const planLookup: OutputLookup = (token) => {
  const output = token.resource.output as Record<string, unknown> | null;
  if (output == null) return { known: false };
  if (isMissingRequiredOutput(token.resource.schema, output, token.path[0])) {
    return { known: false };
  }
  return { known: true, value: readPath(output, token.path) };
};

/**
 * The outputs that the resource's schema requires and `output` lacks. A state
 * record written before an output was added to the resource's type lacks it,
 * and deploy reads the resource again to fill it in.
 */
export function missingRequiredOutputs(
  resource: { schema: Schema },
  output: Record<string, unknown>,
): string[] {
  return Object.keys(resource.schema).filter((key) =>
    isMissingRequiredOutput(resource.schema, output, key),
  );
}

function isMissingRequiredOutput(
  schema: Schema,
  output: Record<string, unknown>,
  key: string,
): boolean {
  const item = schema[key];
  return (
    item?.propertyType === "computed" &&
    item.presence === "required" &&
    output[key] === undefined
  );
}

/**
 * Whether plan does not know some of the resource's outputs: it has no output
 * yet, or its output lacks a required output.
 */
export function hasPendingOutput(resource: BaseResource): boolean {
  const output = resource.output as Record<string, unknown> | null;
  return output == null || missingRequiredOutputs(resource, output).length > 0;
}

function readPath(output: unknown, path: readonly string[]): unknown {
  let value = output;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Replaces every output ref and derived value with `UNKNOWN_AFTER_APPLY`, at
 * its own path.
 */
export function markUnknownOutputRefs(value: unknown): unknown {
  return mapRefs(
    value,
    () => UNKNOWN_AFTER_APPLY,
    () => UNKNOWN_AFTER_APPLY,
  );
}

/**
 * Writes output refs and derived values in a form that depends only on the
 * resource ID and path of each ref, and the call site of each function, so
 * contributions sort the same whatever order code ran in, and conflict
 * messages can show them.
 */
export function toCanonicalOutputRefs(value: unknown): unknown {
  return mapRefs(
    value,
    (token) => `<output ${describeOutputRef(token)}>`,
    (derived) => derived["~describe"](),
  );
}

function describeOutputRef(token: {
  resource: BaseResource;
  path: readonly string[];
}): string {
  return [token.resource.id, ...token.path].join(".");
}

/**
 * Thrown by a plan view when code reads an output that is not known yet: the
 * output of a dependency that has none, a required output that is missing
 * from a dependency's output, or a value in config that a ref or a derived
 * value gives.
 */
export class PendingOutput extends Error {
  constructor(
    readonly resource: BaseResource,
    message = `The output of ${resource.id} is not known until it is deployed`,
  ) {
    super(message);
    this.name = "PendingOutput";
  }
}

/**
 * Gives views of dependencies for code that runs at plan, and the `pending`
 * function for `deriveParamsConfigView`. A view of a dependency has a view of
 * its config from `deriveParamsConfigView`, in which the refs and derived
 * values that plan knows are filled in, and reading one that it doesn't know
 * throws `PendingOutput`. A view of a dependency with no output
 * throws `PendingOutput` when its output is read. A view of a dependency
 * whose output lacks a required output throws it when that output is read.
 * `readPending` is set by such a read, so a plan still knows of it when the
 * code catches the error. A view's methods run on the dependency, so its
 * `outputRef` names the dependency, not the view. Plan resolves refs after
 * the code has returned, outside `tryAtPlan`, so a ref that named the view
 * would throw `PendingOutput` there instead of planning as unknown.
 */
export function createPlanViews() {
  const views = {
    readPending: false,
    of<Deps extends Record<string, BaseResource | void>>(deps: Deps): Deps {
      const viewed: Record<string, BaseResource | void> = {};
      for (const [name, dep] of Object.entries(deps)) {
        viewed[name] = dep && planView(dep);
      }
      return viewed as Deps;
    },
    /**
     * Throws `PendingOutput` for the first resource that `unresolved` reads.
     * `UNKNOWN_AFTER_APPLY` reads no ref, so its error names the resource
     * whose config holds it.
     */
    pending(unresolved: unknown, holder: BaseResource, param: string): never {
      let resource: BaseResource | undefined;
      forEachOutputRef(unresolved, (token) => {
        resource ??= token.resource;
      });
      views.readPending = true;
      throw resource
        ? new PendingOutput(resource)
        : new PendingOutput(holder, `${param} is not known until deploy`);
    },
  };

  const throwPending = (dep: BaseResource): never => {
    views.readPending = true;
    throw new PendingOutput(dep);
  };

  const planView = (dep: BaseResource): BaseResource => {
    const pending = hasPendingOutput(dep);
    const resolvesConfig = containsRefOrDerived(dep.config);
    if (!pending && !resolvesConfig) return dep;
    const output = dep.output as Record<string, unknown> | null;
    // Deploy fails when a required output is missing, so each one is present
    // at deploy. Each missing one is a getter, so that `in`, `Object.hasOwn`
    // and `Object.keys` give the answers they will give at deploy, and only
    // a read of its value throws.
    const viewedOutput =
      output &&
      Object.defineProperties(
        { ...output },
        Object.fromEntries(
          missingRequiredOutputs(dep, output).map((key) => [
            key,
            { enumerable: true, get: () => throwPending(dep) },
          ]),
        ),
      );
    return dependencyView(dep, {
      output: pending ? () => viewedOutput ?? throwPending(dep) : undefined,
      config: resolvesConfig
        ? () =>
            deriveParamsConfigView(
              dep,
              resolveOutputRefs(dep.config, planLookup),
              views.pending,
            )
        : undefined,
    });
  };

  return views;
}

/**
 * Views of dependencies for `deriveParams` and function contributions at
 * deploy, each with its config filled in. The config is a view from
 * `deriveParamsConfigView`.
 */
export function deployViews<Deps extends Record<string, BaseResource | void>>(
  deps: Deps,
): Deps {
  const viewed: Record<string, BaseResource | void> = {};
  for (const [name, dep] of Object.entries(deps)) {
    viewed[name] =
      dep && containsRefOrDerived(dep.config)
        ? dependencyView(dep, {
            config: () =>
              deriveParamsConfigView(
                dep,
                resolveOutputRefs(dep.config, deployLookup),
              ),
          })
        : dep;
  }
  return viewed as Deps;
}

// A view has none of the dependency's private fields, so `outputRef`,
// `credentials` and `~state` run on the dependency, which also makes a ref
// name the dependency and not the view. Other getters run on the view, so
// that `key` reads the view's output. Config is filled in on its first read,
// so code that doesn't read it doesn't run the functions of its derived
// values.
function dependencyView(
  dep: BaseResource,
  replaced: { output?: () => unknown; config?: () => unknown },
): BaseResource {
  const view: PropertyDescriptorMap = {
    outputRef: { value: dep.outputRef.bind(dep) },
    credentials: { get: () => dep.credentials },
    "~state": { get: () => dep["~state"] },
  };
  if (replaced.output) view.output = { get: replaced.output };
  const fillConfig = replaced.config;
  if (fillConfig) {
    let config: { value: unknown } | undefined;
    view.config = { get: () => (config ??= { value: fillConfig() }).value };
  }
  return Object.create(dep, view);
}

/**
 * A view of the config that `deriveParams` receives, at plan and at deploy.
 * Reading a marker in it throws, as `deriveParams` would compute with the
 * marker in place of the value. An `OwnPhysicalName` stands for a name that
 * deploy decides after the params. A credential marker stands for a value
 * that deploy puts in place of the marker only for the call to an
 * operation. Reading a ref or a derived value that is left in config, which
 * only plan leaves, calls `onPending`. So does reading `UNKNOWN_AFTER_APPLY`,
 * which plan gives for a credential that deploy rotates.
 */
export function deriveParamsConfigView(
  owner: BaseResource,
  config: unknown,
  onPending?: (
    unresolved: unknown,
    holder: BaseResource,
    param: string,
  ) => never,
): unknown {
  const guarded = (value: unknown) =>
    isOwnPhysicalName(value) ||
    isCredentialMarker(value) ||
    (onPending !== undefined &&
      (isRefOrDerived(value) || isUnknownAfterApply(value)));
  return guardedReadView(config, guarded, (value, path) => {
    const param = [owner.id, ...path].join(".");
    if (isOwnPhysicalName(value)) {
      throw new Error(
        `${param} is the physical name of ${owner.id} itself, which deploy decides after the params, so deriveParams can't read it.`,
      );
    }
    if (isCredentialMarker(value)) {
      const { resource, name } = value.$credential;
      throw new Error(
        `${param} is the credential ${resource}.${name}, which deploy puts in the params only for the call to an operation, so deriveParams can't read it.`,
      );
    }
    return onPending!(value, owner, param);
  });
}

// Copies the objects and arrays that hold a value that `guarded` matches,
// with a getter in place of each, which calls `onRead` with the value and
// its path.
function guardedReadView(
  value: unknown,
  guarded: (value: unknown) => boolean,
  onRead: (value: unknown, path: string[]) => never,
  path: string[] = [],
): unknown {
  if (guarded(value)) return onRead(value, path);
  if (!containsMatch(value, guarded)) return value;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? new Array(value.length)
    : {};
  for (const [key, entry] of Object.entries(value as object)) {
    const at = [...path, key];
    if (guarded(entry)) {
      Object.defineProperty(copy, key, {
        enumerable: true,
        get: () => onRead(entry, at),
      });
    } else {
      (copy as Record<string, unknown>)[key] = guardedReadView(
        entry,
        guarded,
        onRead,
        at,
      );
    }
  }
  return copy;
}

export type PlanViews = ReturnType<typeof createPlanViews>;

type DerivedOptions<T> = {
  inputs: readonly unknown[];
  compute: (values: unknown[]) => T;
  describe: () => string;
};

/**
 * A value computed from refs, which deploy fills in. Made by `text`, `all`
 * and `map`. It holds the values it reads and a function of them. Plan runs
 * the function when every ref it reads is known, and deploy runs it with the
 * values.
 */
export class Derived<T = unknown> extends Unstringable {
  readonly [derivedBrand] = true as const;
  declare readonly "~value"?: () => T;
  /** The refs, derived values and plain values that the function reads. */
  readonly "~inputs": readonly unknown[];
  readonly "~compute": (values: unknown[]) => T;
  readonly "~describe": () => string;

  constructor(options: DerivedOptions<T>) {
    super();
    this["~inputs"] = options.inputs;
    this["~compute"] = options.compute;
    this["~describe"] = options.describe;
  }

  /** See `OutputRef.map`. */
  map<U>(fn: (value: T) => U): Derived<U> {
    const callSite = captureCallSiteLazily(Derived.prototype.map, {
      skipLibraryFrames: true,
    });
    return mapDerived(this, fn as (value: unknown) => U, callSite);
  }

  protected stringError(): OutputRefStringError {
    return new OutputRefStringError(
      `Derived value ${this["~describe"]()}`,
      "a derived value",
    );
  }
}

/**
 * Joins strings, numbers, refs and derived values into a string that deploy
 * fills in: `` text`${api.url}/callback` ``. Each ref must hold a string or
 * a number when it is filled in. A credential or a `~state` ref can't be
 * joined. Code that runs in a function can't call it.
 * @resource
 */
export function text(
  strings: TemplateStringsArray,
  ...parts: Input<string | number>[]
): Derived<string> {
  const callSite = captureCallSiteLazily(text, { skipLibraryFrames: true });
  const where = () => `text\`…\` at ${site(callSite)}`;
  for (const part of parts) assertDerivable(part, where);
  const literals = [...strings];
  return new Derived({
    inputs: parts,
    compute: (values) => {
      let joined = literals[0]!;
      values.forEach((value, index) => {
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error(
            `${where()}: ${describeInput(parts[index])} is ${describeType(value)}, not a string or a number`,
          );
        }
        joined += String(value) + literals[index + 1]!;
      });
      return joined;
    },
    describe: () => {
      let described = literals[0]!;
      parts.forEach((part, index) => {
        described +=
          isOutputRef(part) || isDerived(part)
            ? (toCanonicalOutputRefs(part) as string)
            : String(part);
        described += literals[index + 1]!;
      });
      return described;
    },
  });
}

/**
 * Gives a derived value of the list of the values of `refs`, to compute with
 * several outputs: `all([a.url, b.arn]).map(([url, arn]) => ...)`. Code
 * that runs in a function can't call it.
 * @resource
 */
export function all<const R extends readonly (OutputRef<any> | Derived<any>)[]>(
  refs: R,
): Derived<{ -readonly [K in keyof R]: Resolved<R[K]> }> {
  const callSite = captureCallSiteLazily(all, { skipLibraryFrames: true });
  const where = () => `all() at ${site(callSite)}`;
  for (const ref of refs) assertDerivable(ref, where);
  return new Derived({
    inputs: [...refs],
    compute: (values) => values as { -readonly [K in keyof R]: Resolved<R[K]> },
    // The canonical form leaves out the call site, as `text` does, so that
    // moving the call doesn't reorder a collected list.
    describe: () =>
      `<all of ${refs.map((ref) => describeInput(ref)).join(", ")}>`,
  });
}

function mapDerived<U>(
  input: AnyOutputRef | Derived,
  fn: (value: unknown) => U,
  callSite: () => string | undefined,
): Derived<U> {
  const where = () => `The function of map() at ${site(callSite)}`;
  return new Derived({
    inputs: [input],
    compute: ([value]) => {
      let result: U;
      try {
        result = fn(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${where()} threw: ${message}`, { cause: error });
      }
      assertRecordable(result, where);
      return result;
    },
    describe: () => `<map of ${describeInput(input)} at ${site(callSite)}>`,
  });
}

function site(callSite: () => string | undefined): string {
  return callSite() ?? "an unknown call site";
}

// A value computed from a credential would be recorded in state as a plain
// param. A `~state` ref can only be placed whole in a contribution.
function assertDerivable(value: unknown, where: () => string): void {
  if (isCredentialRef(value)) {
    throw new Error(
      `${where()} reads the credential ${describeOutputRef(value)}. A credential can only be placed whole, because a value computed from it would be recorded in state as a plain param.`,
    );
  }
  if (isStateRef(value)) {
    throw new Error(
      `${where()} reads the ~state ref ${describeOutputRef(value)}. A ~state ref can only be placed whole in a contribution.`,
    );
  }
}

// State records the result as a param. A promise, a function, or an object
// that is not a plain object or an array can't be recorded, and a ref in the
// result was not seen when the dependencies were found.
function assertRecordable(value: unknown, where: () => string): void {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new Error(
      `${where()} returned a promise. The function must return its value.`,
    );
  }
  if (containsRefOrDerived(value)) {
    throw new Error(
      `${where()} returned a value that holds an output ref or a derived value. Read each ref as an argument, with all() for several.`,
    );
  }
  const found = findUnrecordable(value, []);
  if (found) {
    const at = found.path.length > 0 ? ` at ${found.path.join(".")}` : "";
    throw new Error(
      `${where()} returned ${describeUnrecordable(found.value)}${at}, which state can't record.`,
    );
  }
}

function findUnrecordable(
  value: unknown,
  path: string[],
): { value: unknown; path: string[] } | undefined {
  if (
    typeof value === "function" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return { value, path };
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (!Array.isArray(value) && !isPlainObject(value)) return { value, path };
  for (const [key, entry] of Object.entries(value)) {
    const found = findUnrecordable(entry, [...path, key]);
    if (found) return found;
  }
  return undefined;
}

function describeUnrecordable(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (typeof value === "bigint") return "a bigint";
  if (typeof value === "symbol") return "a symbol";
  const name = (value as object).constructor?.name;
  if (!name) return "an object of a class";
  return `${/^[AEIO]/i.test(name) ? "an" : "a"} ${name}`;
}

function describeInput(input: unknown): string {
  if (isOutputRef(input)) return describeOutputRef(input);
  if (isDerived(input)) return input["~describe"]();
  return JSON.stringify(input) ?? String(input);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "undefined") return "undefined";
  return `a ${typeof value}`;
}

/**
 * Computes a derived value when `lookup` knows every ref it reads. A ref to
 * the own `physicalName` of a resource can't be read: deploy decides the
 * name after the params, and the lookup gives a marker in its place.
 */
function resolveDerived(
  derived: Derived,
  lookup: OutputLookup,
): { known: true; value: unknown } | { known: false } {
  const values: unknown[] = [];
  for (const input of derived["~inputs"]) {
    let found: { known: true; value: unknown } | { known: false };
    if (isOutputRef(input)) {
      found = lookup(input);
      if (found.known && isOwnPhysicalName(found.value)) {
        throw new Error(
          `${derived["~describe"]()} reads ${describeOutputRef(input)}, the physical name of ${input.resource.id} itself. Deploy decides the name after the params, so it can only be placed whole.`,
        );
      }
    } else if (isDerived(input)) {
      found = resolveDerived(input, lookup);
    } else {
      found = { known: true, value: input };
    }
    if (!found.known) return found;
    // Plan gives this for a credential that deploy rotates.
    if (isUnknownAfterApply(found.value)) return { known: false };
    values.push(found.value);
  }
  return { known: true, value: derived["~compute"](values) };
}
