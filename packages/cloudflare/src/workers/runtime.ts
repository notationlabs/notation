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
export { KVJsonError, readKVJson } from "./kv-json";

/** Declares nothing at runtime. The Worker reads its bindings from `env`. */
export function $worker<
  const Id extends string,
  B extends Bindings = {},
  E = undefined,
>(config: WorkerDeclarationConfig<Id, B, E>): Worker<ResolvedValues<B>, E> {
  return { id: config.id } as unknown as Worker<ResolvedValues<B>, E>;
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
