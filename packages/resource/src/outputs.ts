/**
 * The key of a binding that runtime code imports from an infra module, such
 * as `infra/orders#orderQueue`.
 * @param module The infra module's path relative to the project root,
 * without its extension.
 * @param binding The export's name, or `default`.
 */
export function bindingKey(module: string, binding: string): string {
  return `${module}#${binding}`;
}

/**
 * The key of a value that runtime code reads from an infra module, such as
 * `infra/orders#orderQueue.url`. Without a path, it is the key of the whole
 * binding.
 */
export function outputKey(
  module: string,
  binding: string,
  path: readonly string[] = [],
): string {
  return [bindingKey(module, binding), ...path].join(".");
}

export type ParsedOutputKey = {
  module: string;
  binding: string;
  path: string[];
};

/** Splits a key that `outputKey` made. Throws on any other string. */
export function parseOutputKey(key: string): ParsedOutputKey {
  const hash = key.lastIndexOf("#");
  const [binding, ...path] = key.slice(hash + 1).split(".");
  if (hash <= 0 || !binding || path.some((segment) => segment === "")) {
    throw new Error(
      `${JSON.stringify(key)} is not an output key, such as "infra/orders#orderQueue.url".`,
    );
  }
  return { module: key.slice(0, hash), binding, path };
}

/** Whether a path segment can be part of an output key. */
export function isKeySegment(segment: string): boolean {
  return segment !== "" && !/[.#]/.test(segment);
}

type OutputStore = {
  values: Map<string, unknown>;
  sources: Array<() => Record<string, unknown> | undefined>;
};

// `Symbol.for` gives every copy of this module the same store, so a provider
// and a test hook can fill the store that the bundle's `read` uses.
const storeKey = Symbol.for("@notation/resource/outputs");

function store(): OutputStore {
  const global = globalThis as { [storeKey]?: OutputStore };
  return (global[storeKey] ??= { values: new Map(), sources: [] });
}

/**
 * Sets values that `read` returns, keyed by output key. A key for a whole
 * binding, such as `infra/orders#orderQueue`, also serves the reads of its
 * paths.
 */
export function setOutputValues(values: Record<string, unknown>): void {
  const { values: current } = store();
  for (const [key, value] of Object.entries(values)) current.set(key, value);
}

/** Removes every value, whether `setOutputValues` set it or a source gave it. */
export function clearOutputValues(): void {
  store().values.clear();
}

/**
 * Adds a source of values, such as a function's environment. Each source is
 * called once, at the first `read` after it was added, and its values don't
 * replace values that are already set.
 */
export function addOutputSource(
  source: () => Record<string, unknown> | undefined,
): void {
  store().sources.push(source);
}

function loadSources(): Map<string, unknown> {
  const { values, sources } = store();
  while (sources.length > 0) {
    const delivered = sources.shift()!() ?? {};
    for (const [key, value] of Object.entries(delivered)) {
      if (!values.has(key)) values.set(key, value);
    }
  }
  return values;
}

/**
 * Finds the value of a read as `read` does, but gives `undefined` in place of
 * throwing when no value is set. The value is wrapped, since a set value can
 * itself be `undefined`.
 */
export function findOutputValue(
  binding: string,
  path: readonly string[],
): { value: unknown } | undefined {
  const values = loadSources();
  for (let length = path.length; length >= 0; length -= 1) {
    const key = [binding, ...path.slice(0, length)].join(".");
    if (!values.has(key)) continue;
    let value = values.get(key);
    for (const segment of path.slice(length)) {
      value = (value as Record<string, unknown> | null | undefined)?.[segment];
    }
    return { value };
  }
  return undefined;
}

/**
 * Whether a value is set for a key below `key`, such as
 * `infra/api#api.stage.url` below `infra/api#api.stage`.
 */
export function hasOutputValuesBelow(key: string): boolean {
  const prefix = `${key}.`;
  return [...loadSources().keys()].some((set) => set.startsWith(prefix));
}

/**
 * Reads a value that infra delivered to runtime code. The compiler rewrites
 * each use of a `type: "infra"` import into a call to this, such as
 * `read("infra/orders#orderQueue", ["url"])` for `orderQueue.url`.
 * @param binding The binding's key, from `bindingKey`.
 * @param path The properties read on the binding. Empty for the whole
 * binding.
 */
export function read(binding: string, path: readonly string[]): unknown {
  const found = findOutputValue(binding, path);
  if (found) return found.value;
  throw new Error(
    `No value for ${[binding, ...path].join(".")}. A function receives the values it reads from infra when it deploys, and a test stubs them with stubOutputs().`,
  );
}
