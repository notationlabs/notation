import type { BaseResource } from "./resource";
import type { Schema } from "./resource.schema";
import type { DurableObject } from "./durable-value";
import { UNKNOWN_AFTER_APPLY } from "./diff-params";

export class OutputRefStringError extends Error {
  constructor(output: string) {
    super(
      `Output ${output}: an output ref can't be turned into a string; place it whole, or compute with it in a function that receives deps`,
    );
    this.name = "OutputRefStringError";
  }
}

/**
 * Stands for a path into a resource's output, which deploy fills in. It can
 * only be placed whole in config or in a contribution. Turning it into a
 * string throws, because the string would not hold the value.
 */
export class OutputRef {
  constructor(
    readonly resource: BaseResource,
    readonly path: readonly string[],
  ) {}

  [Symbol.toPrimitive](): never {
    throw new OutputRefStringError(describeOutputRef(this));
  }

  toString(): never {
    throw new OutputRefStringError(describeOutputRef(this));
  }

  toJSON(): never {
    throw new OutputRefStringError(describeOutputRef(this));
  }
}

/**
 * Stands for an output in the target's state record at the start of the
 * deploy or plan. Made by `resource["~state"].outputRef`. Unlike an output
 * ref, it adds no dependency, and it resolves to undefined when the target
 * has no record.
 */
export class StateOutputRef extends OutputRef {}

/**
 * The outputs of the targets of `~state` refs, from their state records at
 * the start of the deploy or plan. Each target has an entry, which is null
 * when the target has no full record.
 */
export type RecordedOutputs = { [id: string]: DurableObject | null };

// Deploy reads the outputs of these resources from state once, at the start,
// so it needs to know them before any params exist.
const stateRefTargets = new WeakSet<BaseResource>();

/** Whether a `~state` ref names `resource`. */
export function isStateRefTarget(resource: BaseResource): boolean {
  return stateRefTargets.has(resource);
}

/**
 * Makes a `~state` ref. Throws unless only a replace changes the output: a
 * param that is `immutable`, `primaryKey` or `secondaryKey`, or that has
 * `physicalName`. An output that an update changes would be read one
 * deploy late, with no error.
 */
export function stateOutputRef(
  resource: BaseResource,
  key: string,
): StateOutputRef {
  const item = resource.schema[key];
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
  stateRefTargets.add(resource);
  return new StateOutputRef(resource, [key]);
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
export function isOwnNameRef(owner: BaseResource, token: OutputRef): boolean {
  if (token.resource !== owner || token.path.length !== 1) return false;
  const item = owner.schema[token.path[0]!];
  return item?.propertyType === "param" && Boolean(item.physicalName);
}

/** Whether the holder of `token` depends on the resource it names. */
export function isDependencyRef(
  holder: BaseResource,
  token: OutputRef,
): boolean {
  return !(token instanceof StateOutputRef) && !isOwnNameRef(holder, token);
}

/**
 * Finds the value an output ref stands for. `known: false` means the
 * output does not exist yet, so the value stays a token.
 */
export type OutputLookup = (
  token: OutputRef,
) => { known: true; value: unknown } | { known: false };

export function isOutputRef(value: unknown): value is OutputRef {
  return value instanceof OutputRef;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Walks a value and calls `visit` for every output ref in it. */
export function forEachOutputRef(
  value: unknown,
  visit: (token: OutputRef) => void,
): void {
  if (isOutputRef(value)) return visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) forEachOutputRef(entry, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) forEachOutputRef(entry, visit);
  }
}

export function containsOutputRef(value: unknown): boolean {
  let found = false;
  forEachOutputRef(value, () => {
    found = true;
  });
  return found;
}

/**
 * Copies a value, replacing every output ref in it with the result of
 * `onToken`.
 */
export function mapOutputRefs(
  value: unknown,
  onToken: (token: OutputRef) => unknown,
): unknown {
  if (isOutputRef(value)) return onToken(value);
  if (Array.isArray(value)) {
    return value.map((entry) => mapOutputRefs(entry, onToken));
  }
  if (isPlainObject(value)) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      mapped[key] = mapOutputRefs(entry, onToken);
    }
    return mapped;
  }
  return value;
}

/**
 * Replaces every output ref that `lookup` knows with its value. Output
 * values that `lookup` does not know are left in place.
 */
export function resolveOutputRefs(
  value: unknown,
  lookup: OutputLookup,
): unknown {
  return mapOutputRefs(value, (token) => {
    const found = lookup(token);
    return found.known ? found.value : token;
  });
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

/** Replaces every output ref with `UNKNOWN_AFTER_APPLY`, at its own path. */
export function markUnknownOutputRefs(value: unknown): unknown {
  return mapOutputRefs(value, () => UNKNOWN_AFTER_APPLY);
}

/**
 * Writes output refs in a form that depends only on the resource ID and
 * path, so contributions sort the same whatever order code ran in, and
 * conflict messages can show them.
 */
export function toCanonicalOutputRefs(value: unknown): unknown {
  return mapOutputRefs(
    value,
    (token) => `<output ${describeOutputRef(token)}>`,
  );
}

function describeOutputRef(token: OutputRef): string {
  return [token.resource.id, ...token.path].join(".");
}

/**
 * Thrown by a plan view of a dependency when code reads an output that is not
 * known yet: the output of a dependency that has none, or a required output
 * that is missing from the dependency's output.
 */
export class PendingOutput extends Error {
  constructor(readonly resource: BaseResource) {
    super(`The output of ${resource.id} is not known until it is deployed`);
    this.name = "PendingOutput";
  }
}

/**
 * Gives views of dependencies for code that runs at plan. A view of a
 * dependency with no output throws `PendingOutput` when its output is read.
 * A view of a dependency whose output lacks a required output throws it when
 * that output is read. `readPending` is set by such a read, so a plan still
 * knows of it when the code catches the error. A view's `outputRef` names the
 * dependency, not the view. Plan resolves refs after the code has returned,
 * outside `tryAtPlan`, so a ref that named the view would throw
 * `PendingOutput` there instead of planning as unknown.
 */
export function createPlanViews() {
  const views = {
    readPending: false,
    of<Deps extends Record<string, BaseResource | void>>(deps: Deps): Deps {
      const viewed: Record<string, BaseResource | void> = {};
      for (const [name, dep] of Object.entries(deps)) {
        viewed[name] = dep && hasPendingOutput(dep) ? pendingView(dep) : dep;
      }
      return viewed as Deps;
    },
  };

  const throwPending = (dep: BaseResource): never => {
    views.readPending = true;
    throw new PendingOutput(dep);
  };

  const pendingView = (dep: BaseResource): BaseResource => {
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
    return Object.create(dep, {
      output: { get: () => viewedOutput ?? throwPending(dep) },
      outputRef: { value: dep.outputRef.bind(dep) },
    });
  };

  return views;
}

export type PlanViews = ReturnType<typeof createPlanViews>;
