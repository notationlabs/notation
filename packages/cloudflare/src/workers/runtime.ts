import type {
  Bindings,
  DurableObjectClass,
  DurableObjectDeclaration,
  Worker,
} from "./declaration";
import type { DurableObjectDeclarationConfig } from "./durable-object";
import type { WorkerDeclarationConfig } from "./worker";

// The runtime build resolves `@notation/cloudflare/workers` to this module,
// through the `notation-runtime` export condition. It has the same exports
// as `index.ts`, so the same imports link in both builds, but none of the
// infra code. The types come from `index.ts` in both builds.

export type * from "./declaration";

/** The Worker's view of its declaration. Its code reads bindings from `env`. */
export function $worker<const Id extends string, B extends Bindings = {}>(
  config: WorkerDeclarationConfig<Id, B>,
): Worker<B> {
  return { id: config.id } as unknown as Worker<B>;
}

/** The Worker's view of a namespace declaration. */
export function $durableObject<
  const Id extends string,
  C extends DurableObjectClass,
>(config: DurableObjectDeclarationConfig<Id, C>): DurableObjectDeclaration<C> {
  return { id: config.id } as unknown as DurableObjectDeclaration<C>;
}

const infraOnly = (name: string) =>
  new Error(`${name} declares infrastructure, so it can't run in a Worker.`);

export class WorkerGroup {
  constructor() {
    throw infraOnly("WorkerGroup");
  }
}

export function isWorkerGroup(_value: unknown): false {
  return false;
}
