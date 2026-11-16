import type { EntrypointType } from "./declaration";

// The runtime build also loads this module, so it must only import types.

/**
 * Names the entrypoint class of a `worker()` by its type, where infra code
 * can only import the class as a type:
 * `entrypoint: entrypointType<typeof Github>()`. The value has no meaning.
 *
 * `E` has no constraint, for the same reason as `Worker`'s `E`.
 */
export function entrypointType<E>(): EntrypointType<E> {
  return {} as EntrypointType<E>;
}
