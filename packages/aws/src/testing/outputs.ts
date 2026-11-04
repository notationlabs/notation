// `Symbol.for` gives one store to every copy of this module. Vitest loads the
// plugin and the test's import of `@notation/aws/testing` as two copies.
const storeKey = Symbol.for("@notation/aws/testing/outputs");

function store(): Map<string, unknown> {
  const global = globalThis as { [storeKey]?: Map<string, unknown> };
  return (global[storeKey] ??= new Map());
}

/**
 * Sets the values that runtime code reads from infra in a test. Each key is
 * the infra module's path from the project root without its extension, `#`,
 * the binding, and the path of the property read, such as
 * `infra/orders#orderQueue.url`. A key without a property path,
 * `infra/orders#orderQueue`, sets the whole binding to an object.
 *
 * Each call adds to the values that earlier calls set.
 */
export function setOutputs(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[^#]+#[^.#]+(\.[^.#]+)*$/.test(key)) {
      throw new Error(
        `"${key}" is not an output key. Use the infra module's path from the project root, "#", the binding and the property path, such as "infra/orders#orderQueue.url".`,
      );
    }
    store().set(key, value);
  }
}

/** Removes every value that `setOutputs` set. */
export function clearOutputs(): void {
  store().clear();
}

type Lookup =
  | { found: true; value: unknown }
  | { found: false; nested: boolean };

function lookup(module: string, path: string[]): Lookup {
  const values = store();
  const keyOf = (length: number) =>
    `${module}#${path.slice(0, length).join(".")}`;
  for (let length = path.length; length > 0; length--) {
    if (!values.has(keyOf(length))) continue;
    let value = values.get(keyOf(length));
    for (const segment of path.slice(length)) {
      value = (value as any)?.[segment];
    }
    return { found: true, value };
  }
  const prefix = `${keyOf(path.length)}.`;
  const nested = [...values.keys()].some((key) => key.startsWith(prefix));
  return { found: false, nested };
}

function missing(module: string, path: string[]): Error {
  const key = `${module}#${path.join(".")}`;
  return new Error(
    `No output is set for "${key}". Set it in the test with setOutputs({ "${key}": ... }).`,
  );
}

// Calls on infra, such as `orderQueue.grant([...])` in `lambda()` settings,
// run when the runtime module is imported. Their results only feed the
// settings, which the runtime half of `lambda()` ignores.
const inert: any = new Proxy(function () {}, {
  get: (_, prop) => (prop === "then" ? undefined : inert),
  apply: () => inert,
});

// `grant` stays callable in runtime code, since `lambda()` settings use it.
const callable = new Set(["grant"]);

function view(module: string, path: string[]): any {
  return new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") return undefined;
      if (prop === "toJSON" || prop === Symbol.toPrimitive) {
        return () => {
          const result = lookup(module, path);
          if (!result.found) throw missing(module, path);
          return result.value;
        };
      }
      if (typeof prop === "symbol") return undefined;
      const next = [...path, prop];
      const result = lookup(module, next);
      if (result.found) return result.value;
      if (result.nested) return view(module, next);
      if (callable.has(prop)) return inert;
      throw missing(module, next);
    },
    apply: () => inert,
  });
}

/**
 * The value that a test sees for one export of an infra module, which the
 * Notation loader hook serves in place of the module. Reading a property
 * gives the value set with `setOutputs`, and throws, naming the key, if no
 * value is set.
 * @internal
 */
export function infraBinding(module: string, binding: string): unknown {
  return view(module, [binding]);
}
