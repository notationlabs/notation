import type { BaseResource } from "./resource";
import { UNKNOWN_AFTER_APPLY } from "./diff-params";

export class OutputValueStringError extends Error {
  constructor(output: string) {
    super(
      `Output ${output}: an output value can't be turned into a string; place it whole, or compute with it in a function that receives deps`,
    );
    this.name = "OutputValueStringError";
  }
}

/**
 * Stands for a path into a resource's output, which deploy fills in. It can
 * only be placed whole in config or in a contribution. Turning it into a
 * string throws, because the string would not hold the value.
 */
export class OutputValue {
  constructor(
    readonly resource: BaseResource,
    readonly path: readonly string[],
  ) {}

  [Symbol.toPrimitive](): never {
    throw new OutputValueStringError(describeOutputValue(this));
  }

  toString(): never {
    throw new OutputValueStringError(describeOutputValue(this));
  }

  toJSON(): never {
    throw new OutputValueStringError(describeOutputValue(this));
  }
}

/**
 * Finds the value an output value stands for. `known: false` means the
 * output does not exist yet, so the value stays a token.
 */
export type OutputLookup = (
  token: OutputValue,
) => { known: true; value: unknown } | { known: false };

export function isOutputValue(value: unknown): value is OutputValue {
  return value instanceof OutputValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Walks a value and calls `visit` for every output value in it. */
export function forEachOutputValue(
  value: unknown,
  visit: (token: OutputValue) => void,
): void {
  if (isOutputValue(value)) return visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) forEachOutputValue(entry, visit);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) forEachOutputValue(entry, visit);
  }
}

export function containsOutputValue(value: unknown): boolean {
  let found = false;
  forEachOutputValue(value, () => {
    found = true;
  });
  return found;
}

/**
 * Replaces every output value that `lookup` knows with its value. Output
 * values that `lookup` does not know are left in place.
 */
export function resolveOutputValues(
  value: unknown,
  lookup: OutputLookup,
): unknown {
  if (isOutputValue(value)) {
    const found = lookup(value);
    return found.known ? found.value : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOutputValues(entry, lookup));
  }
  if (isPlainObject(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveOutputValues(entry, lookup);
    }
    return resolved;
  }
  return value;
}

/**
 * Finds output values in the resource's output. The output must exist: a
 * resource holding an output value depends on the resource it came from, so
 * that resource has been deployed first.
 */
export const deployLookup: OutputLookup = (token) => {
  const output = token.resource.output as Record<string, unknown> | null;
  if (output == null) {
    throw new Error(
      `Output ${describeOutputValue(token)} was read before ${token.resource.id} was deployed`,
    );
  }
  return { known: true, value: readPath(output, token.path) };
};

/**
 * Finds output values in the resource's output when it has one, such as the
 * output a plan reads from state, and leaves the rest unknown.
 */
export const planLookup: OutputLookup = (token) => {
  const output = token.resource.output as Record<string, unknown> | null;
  if (output == null) return { known: false };
  return { known: true, value: readPath(output, token.path) };
};

function readPath(output: unknown, path: readonly string[]): unknown {
  let value = output;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Replaces every output value with `UNKNOWN_AFTER_APPLY`, at its own path. */
export function markUnknownOutputValues(value: unknown): unknown {
  if (isOutputValue(value)) return UNKNOWN_AFTER_APPLY;
  if (Array.isArray(value)) return value.map(markUnknownOutputValues);
  if (isPlainObject(value)) {
    const marked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      marked[key] = markUnknownOutputValues(entry);
    }
    return marked;
  }
  return value;
}

/**
 * Writes output values in a form that depends only on the resource ID and
 * path, so contributions sort the same whatever order code ran in, and
 * conflict messages can show them.
 */
export function toCanonicalOutputValues(value: unknown): unknown {
  if (isOutputValue(value)) return `<output ${describeOutputValue(value)}>`;
  if (Array.isArray(value)) return value.map(toCanonicalOutputValues);
  if (isPlainObject(value)) {
    const canonicalised: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      canonicalised[key] = toCanonicalOutputValues(entry);
    }
    return canonicalised;
  }
  return value;
}

function describeOutputValue(token: OutputValue): string {
  return [token.resource.id, ...token.path].join(".");
}

/**
 * Thrown by a plan view of a dependency whose output does not exist yet, when
 * code reads the output.
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
 * `readPending` is set by such a read, so a plan still knows of it when the
 * code catches the error.
 */
export function createPlanViews() {
  const views = {
    readPending: false,
    of<Deps extends Record<string, BaseResource | void>>(deps: Deps): Deps {
      const viewed: Record<string, BaseResource | void> = {};
      for (const [name, dep] of Object.entries(deps)) {
        viewed[name] = dep && dep.output == null ? pendingView(dep) : dep;
      }
      return viewed as Deps;
    },
  };

  const pendingView = (dep: BaseResource): BaseResource =>
    Object.create(dep, {
      output: {
        get() {
          views.readPending = true;
          throw new PendingOutput(dep);
        },
      },
    });

  return views;
}
