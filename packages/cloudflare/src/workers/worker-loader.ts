import type { WorkerLoaderBinding } from "./declaration";

// The runtime build also loads this module, so it must only import types.

/**
 * Binds a Worker Loader, which loads code into a new isolate at runtime. The
 * binding has no resource, so deploy creates and deletes nothing for it.
 */
export function workerLoader(): WorkerLoaderBinding {
  return { "~workerLoader": true };
}

export function isWorkerLoaderBinding(
  value: unknown,
): value is WorkerLoaderBinding {
  return (
    typeof value === "object" && value !== null && "~workerLoader" in value
  );
}
