// Only type-checked. The tests import its types, so vitest never loads it.
import type * as cf from "@cloudflare/workers-types";
import { $worker, addBindings, type WorkerEnv } from "src/workers";
import type { secretsStore } from "src/resources";

// The classes of `cloudflare:workers`, which the package's types declare
// only in their global form.
declare const WorkerEntrypoint: typeof cf.CloudflareWorkersModule.WorkerEntrypoint;
declare const DurableObject: typeof cf.CloudflareWorkersModule.DurableObject;

declare const rootKey: InstanceType<typeof secretsStore.SecretsStoreSecret>;

export type Input = { headers: Record<string, string>; body: string };

export default class Github extends WorkerEntrypoint<WorkerEnv<typeof github>> {
  async receive(input: Input) {
    const key: cf.SecretsStoreSecret = this.env.ROOT_KEY;
    // @ts-expect-error a name that the Worker doesn't bind
    this.env.MISSING;
    return { key: await key.get(), length: input.body.length };
  }
}

export const github = $worker({
  id: "github",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ROOT_KEY: rootKey }),
  entrypoint: Github,
  url: false,
});

export const plain = $worker({ id: "plain", compatibilityDate: "2026-10-12" });

export class Room extends DurableObject {}

export const room = $worker({
  id: "room",
  compatibilityDate: "2026-10-12",
  entrypoint: Room,
});

export const router = $worker({
  id: "router",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ GITHUB: github, PLAIN: plain, ROOM: room }),
});

// Bound in one direction through `bindings`, which keeps that direction
// typed, and in the other through addBindings().
export class Reports extends WorkerEntrypoint<WorkerEnv<typeof reports>> {
  total() {
    return 1;
  }
}

export const reports = $worker({
  id: "reports",
  compatibilityDate: "2026-10-12",
  entrypoint: Reports,
});

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ REPORTS: reports }),
});

addBindings(reports, { API: api });
