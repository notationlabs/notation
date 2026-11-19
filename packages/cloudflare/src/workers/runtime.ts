import type {
  Bindings,
  DurableObjectClass,
  DurableObjectDeclaration,
  Worker,
} from "./declaration";
import type { ResolvedValues } from "@notation/resource";
import type { DurableObjectDeclarationConfig } from "./durable-object";
import type { WorkerDeclarationConfig } from "./worker";

// The runtime build resolves `@notation/cloudflare/workers` to this module,
// so it exports the same names as `index.ts`.

export type * from "./declaration";
export { entrypointType } from "./entrypoint";
export { json } from "./json";
export { workerLoader } from "./worker-loader";
export { KVJsonError, readKVJson } from "./kv-json";

/**
 * Declares nothing at runtime. The Worker reads its bindings from `env`.
 * Each output, such as `url`, is a getter that throws, for a read that the
 * build can't see, such as one in a helper that the Worker passes it to. It
 * isn't enumerable, so a spread doesn't read it.
 */
export function $worker<
  const Id extends string,
  B extends Bindings = {},
  E = undefined,
>(config: WorkerDeclarationConfig<Id, B, E>): Worker<ResolvedValues<B>, E> {
  const declaration = { id: config.id };
  for (const output of ["url", "scriptName"]) {
    Object.defineProperty(declaration, output, {
      enumerable: false,
      get() {
        throw new Error(
          `Worker code read ${output}, an output of $worker({ id: ${JSON.stringify(config.id)} }). An output is known only at deploy, so Worker code can't read it. Bind it to the Worker that needs it, and read it from env.`,
        );
      },
    });
  }
  return declaration as unknown as Worker<ResolvedValues<B>, E>;
}

/** Declares nothing at runtime. */
export function $durableObject<
  const Id extends string,
  C extends DurableObjectClass,
>(config: DurableObjectDeclarationConfig<Id, C>): DurableObjectDeclaration<C> {
  return { id: config.id } as unknown as DurableObjectDeclaration<C>;
}

const infraOnly = (name: string) =>
  new Error(`${name} declares infrastructure, so it can't run in a Worker.`);

/**
 * The mark fails the runtime build of a Worker that calls it.
 * @resource
 */
export function worker(): never {
  throw infraOnly("worker()");
}

export class WorkerGroup {
  constructor() {
    throw infraOnly("WorkerGroup");
  }
}

export function isWorkerGroup(_value: unknown): false {
  return false;
}

/**
 * The mark fails the runtime build of a Worker that calls it.
 * @resource
 */
export function addBindings(_worker: Worker<any>, _bindings: Bindings): never {
  throw infraOnly("addBindings()");
}
