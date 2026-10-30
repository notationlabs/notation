import type { BaseResource } from "./resource";
import { UNKNOWN_AFTER_APPLY } from "./diff-params";

/** Where an output value comes from: a path into a resource's output. */
export type OutputValueRef = {
  readonly resource: BaseResource;
  readonly path: readonly string[];
  readonly placeholder: string;
};

/**
 * Finds the value an output value stands for. `known: false` means the
 * output does not exist yet, so the value stays a token.
 */
export type OutputLookup = (
  ref: OutputValueRef,
) => { known: true; value: unknown } | { known: false };

export class OutputValueKeyError extends Error {
  constructor(output: string) {
    super(
      `Output ${output} is used as a map key. Output values can only be placed in values: key the entry by something known now, and put the output value inside it.`,
    );
    this.name = "OutputValueKeyError";
  }
}

const REF = Symbol("notation.outputValue");
const PLACEHOLDER = /⟦\d+:[^⟦⟧]*⟧/g;

// Properties that code reads to find out what a value is. A token has none
// of them, so it is not thenable, and test matchers and printers treat it as
// a plain object.
const NOT_PATHS = new Set([
  "then",
  "constructor",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
]);

const refsByPlaceholder = new Map<string, OutputValueRef>();
const tokensByResource = new WeakMap<BaseResource, Map<string, unknown>>();
let nextPlaceholder = 0;

/**
 * Returns the token for a path into a resource's output. The token is typed
 * as the value it stands for, so it can be placed anywhere in config. Turned
 * into a string, it becomes a placeholder, so it can also sit inside a
 * template string. Reading a property of the token gives the token for the
 * path below it. The same path always gives the same token.
 */
export function createOutputValue(
  resource: BaseResource,
  path: readonly string[],
): any {
  let tokens = tokensByResource.get(resource);
  if (!tokens) {
    tokens = new Map();
    tokensByResource.set(resource, tokens);
  }
  const pathKey = JSON.stringify(path);
  const existing = tokens.get(pathKey);
  if (existing) return existing;

  const placeholder = `⟦${nextPlaceholder++}:${[resource.id, ...path].join(".")}⟧`;
  const ref: OutputValueRef = { resource, path: [...path], placeholder };
  refsByPlaceholder.set(placeholder, ref);
  const toPlaceholder = () => placeholder;

  const token = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === REF) return ref;
      if (property === Symbol.toPrimitive) return toPlaceholder;
      if (typeof property === "symbol") return undefined;
      if (
        property === "toString" ||
        property === "toJSON" ||
        property === "valueOf"
      ) {
        return toPlaceholder;
      }
      if (NOT_PATHS.has(property)) return undefined;
      return createOutputValue(resource, [...path, property]);
    },
    has: (_target, property) => property === REF,
    ownKeys: () => [],
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  tokens.set(pathKey, token);
  return token;
}

export function getOutputValueRef(value: unknown): OutputValueRef | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<symbol, OutputValueRef | undefined>)[REF];
}

export function isOutputValue(value: unknown): boolean {
  return getOutputValueRef(value) !== undefined;
}

function placeholderRefs(text: string): OutputValueRef[] {
  const refs: OutputValueRef[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const ref = refsByPlaceholder.get(match[0]);
    if (ref) refs.push(ref);
  }
  return refs;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Walks a value and calls `visit` for every output value in it: each token,
 * and each placeholder inside a string.
 */
export function forEachOutputValue(
  value: unknown,
  visit: (ref: OutputValueRef) => void,
): void {
  const ref = getOutputValueRef(value);
  if (ref) return visit(ref);
  if (typeof value === "string") {
    for (const found of placeholderRefs(value)) visit(found);
    return;
  }
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
 * Replaces every output value that `lookup` knows with its value. A string
 * that is exactly one placeholder takes the value whole, so a number stays a
 * number; a placeholder inside a longer string is replaced by its text.
 * Output values that `lookup` does not know are left in place.
 *
 * Throws when an output value is a map key, because a key must be known to
 * merge maps and to diff them.
 */
export function resolveOutputValues(
  value: unknown,
  lookup: OutputLookup,
): unknown {
  const ref = getOutputValueRef(value);
  if (ref) {
    const found = lookup(ref);
    return found.known ? found.value : value;
  }
  if (typeof value === "string") return resolveString(value, lookup);
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOutputValues(entry, lookup));
  }
  if (isPlainObject(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const keyRef = placeholderRefs(key)[0];
      if (keyRef) {
        throw new OutputValueKeyError(describeRef(keyRef));
      }
      resolved[key] = resolveOutputValues(entry, lookup);
    }
    return resolved;
  }
  return value;
}

function resolveString(text: string, lookup: OutputLookup): unknown {
  if (!text.includes("⟦")) return text;
  const whole = refsByPlaceholder.get(text);
  if (whole) {
    const found = lookup(whole);
    return found.known ? found.value : text;
  }
  return text.replace(PLACEHOLDER, (placeholder) => {
    const ref = refsByPlaceholder.get(placeholder);
    if (!ref) return placeholder;
    const found = lookup(ref);
    if (!found.known) return placeholder;
    if (found.value === undefined || found.value === null) {
      throw new Error(
        `Output ${describeRef(ref)} is ${found.value}, so it cannot be interpolated into "${text}"`,
      );
    }
    return typeof found.value === "string"
      ? found.value
      : JSON.stringify(found.value);
  });
}

/**
 * Finds output values in the resource's output. The output must exist: a
 * resource holding an output value depends on the resource it came from, so
 * that resource has been deployed first.
 */
export const deployLookup: OutputLookup = (ref) => {
  const output = ref.resource.output as Record<string, unknown> | null;
  if (output == null) {
    throw new Error(
      `Output ${describeRef(ref)} was read before ${ref.resource.id} was deployed`,
    );
  }
  return { known: true, value: readPath(output, ref.path) };
};

/**
 * Finds output values in the resource's output when it has one, such as the
 * output a plan reads from state, and leaves the rest unknown.
 */
export const planLookup: OutputLookup = (ref) => {
  const output = ref.resource.output as Record<string, unknown> | null;
  if (output == null) return { known: false };
  return { known: true, value: readPath(output, ref.path) };
};

function readPath(output: unknown, path: readonly string[]): unknown {
  let value = output;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export type UnknownMarking = {
  value: unknown;
  // The output values left in place, which the marking made unknown.
  refs: Set<OutputValueRef>;
  // Whether a string holds part of a placeholder: code took a token apart,
  // so the value cannot be trusted.
  mangled: boolean;
};

/**
 * Replaces every value that holds an output value with `UNKNOWN_AFTER_APPLY`,
 * at its own path, so the rest of the value stays known.
 */
export function markUnknownOutputValues(value: unknown): UnknownMarking {
  const refs = new Set<OutputValueRef>();
  let mangled = false;

  const mark = (entry: unknown): unknown => {
    const ref = getOutputValueRef(entry);
    if (ref) {
      refs.add(ref);
      return UNKNOWN_AFTER_APPLY;
    }
    if (typeof entry === "string") {
      const found = placeholderRefs(entry);
      for (const foundRef of found) refs.add(foundRef);
      const rest = entry.replace(PLACEHOLDER, (placeholder) =>
        refsByPlaceholder.has(placeholder) ? "" : placeholder,
      );
      if (rest.includes("⟦") || rest.includes("⟧")) mangled = true;
      return found.length > 0 ? UNKNOWN_AFTER_APPLY : entry;
    }
    if (Array.isArray(entry)) return entry.map(mark);
    if (isPlainObject(entry)) {
      const marked: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(entry)) {
        marked[key] = mark(nested);
      }
      return marked;
    }
    return entry;
  };

  return { value: mark(value), refs, mangled };
}

/**
 * Writes output values in a form that depends only on the resource ID and
 * path, so contributions sort the same whatever order tokens were made in.
 */
export function toCanonicalOutputValues(value: unknown): unknown {
  const ref = getOutputValueRef(value);
  if (ref) return canonical(ref);
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (placeholder) => {
      const found = refsByPlaceholder.get(placeholder);
      return found ? canonical(found) : placeholder;
    });
  }
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

function canonical(ref: OutputValueRef): string {
  return `⟦${describeRef(ref)}⟧`;
}

function describeRef(ref: OutputValueRef): string {
  return [ref.resource.id, ...ref.path].join(".");
}

/**
 * A view of a resource's output whose fields are tokens, for the plan of a
 * dependent whose dependency has no output yet. `onRead` is called with each
 * token read from it.
 */
export function createOutputProxy(
  resource: BaseResource,
  onRead: (ref: OutputValueRef) => void,
): Record<string, unknown> {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === "symbol" || NOT_PATHS.has(property)) {
        return undefined;
      }
      const token = createOutputValue(resource, [property]);
      onRead(getOutputValueRef(token)!);
      return token;
    },
    ownKeys: () => [],
  });
}
