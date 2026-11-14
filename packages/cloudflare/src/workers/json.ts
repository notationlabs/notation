import type { Json, JsonBinding } from "./declaration";

// The runtime build also loads this module, so it must only import types.

/**
 * Binds a JSON value. In the Worker, the binding is the parsed value. The
 * value is stored in state and shown in plans, so don't put secrets in it.
 */
export function json<T extends Json>(value: T): JsonBinding<T> {
  return { "~json": value };
}

export function isJsonBinding(value: unknown): value is JsonBinding {
  return typeof value === "object" && value !== null && "~json" in value;
}
