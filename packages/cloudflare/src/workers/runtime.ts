import type {
  Bindings,
  DurableObjectClass,
  DurableObjectDeclaration,
  Worker,
} from "./declaration";
import type { DurableObjectDeclarationConfig } from "./durable-object";
import type { WorkerDeclarationConfig } from "./worker";

// The runtime build resolves `@notation/cloudflare/workers` to this module,
// so it exports the same names as `index.ts`.

export type * from "./declaration";
export { secretsStore } from "./secrets-store";

/** Declares nothing at runtime. The Worker reads its bindings from `env`. */
export function $worker<const Id extends string, B extends Bindings = {}>(
  config: WorkerDeclarationConfig<Id, B>,
): Worker<B> {
  return { id: config.id } as unknown as Worker<B>;
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

export class WorkerGroup {
  constructor() {
    throw infraOnly("WorkerGroup");
  }
}

export function isWorkerGroup(_value: unknown): false {
  return false;
}
