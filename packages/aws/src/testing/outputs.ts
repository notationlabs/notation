import {
  bindingKey,
  clearOutputValues,
  findOutputValue,
  hasOutputValuesBelow,
  outputKey,
  parseOutputKey,
  setOutputValues,
} from "@notation/resource/outputs";

/**
 * Sets the values that runtime code reads from infra in a test. Each key is
 * the infra module's path from the project root without its extension, `#`,
 * the binding, and the path of the property read, such as
 * `infra/orders#orderQueue.url`. A key without a property path,
 * `infra/orders#orderQueue`, sets the whole binding to an object.
 *
 * Each call adds to the values that earlier calls set.
 */
export function stubOutputs(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    try {
      parseOutputKey(key);
    } catch {
      throw new Error(
        `"${key}" is not an output key. Use the infra module's path from the project root, "#", the binding and the property path, such as "infra/orders#orderQueue.url".`,
      );
    }
  }
  setOutputValues(values);
}

/** Removes every value that `stubOutputs` stubbed. */
export function unstubOutputs(): void {
  clearOutputValues();
}

function missing(module: string, binding: string, path: string[]): Error {
  const key = outputKey(module, binding, path);
  return new Error(
    `No output is stubbed for "${key}". Stub it in the test with stubOutputs({ "${key}": ... }).`,
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

function view(module: string, binding: string, path: string[]): any {
  const key = bindingKey(module, binding);
  return new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") return undefined;
      if (prop === "toJSON" || prop === Symbol.toPrimitive) {
        return () => {
          const found = findOutputValue(key, path);
          if (!found) throw missing(module, binding, path);
          return found.value;
        };
      }
      if (typeof prop === "symbol") return undefined;
      const next = [...path, prop];
      const found = findOutputValue(key, next);
      if (found) return found.value;
      if (hasOutputValuesBelow(outputKey(module, binding, next))) {
        return view(module, binding, next);
      }
      if (callable.has(prop)) return inert;
      throw missing(module, binding, next);
    },
    apply: () => inert,
  });
}

/**
 * The value that a test sees for one export of an infra module, which the
 * Notation loader hook serves in place of the module. Reading a property
 * gives the value stubbed with `stubOutputs`, and throws, naming the key, if no
 * value is set.
 * @internal
 */
export function infraBinding(module: string, binding: string): unknown {
  return view(module, binding, []);
}
