import type { Json, JsonBinding, JsonValue } from "./declaration";

// The runtime build also loads this module, so it must only import types.

/**
 * Binds a JSON value. In the Worker, the binding is the parsed value. The
 * value is stored in state and shown in plans, so don't put secrets in it.
 */
export function json<T extends Json>(value: T): JsonBinding<T>;
// For a value typed as an interface, which `Json` doesn't accept. Inference
// through this signature keeps literal types, so it comes second.
export function json<T extends object>(value: T & JsonValue<T>): JsonBinding<T>;
export function json(value: unknown): JsonBinding<unknown> {
  return { "~json": value };
}

export function isJsonBinding(value: unknown): value is JsonBinding {
  return typeof value === "object" && value !== null && "~json" in value;
}
