// Only type-checked. The tests import its types, so vitest never loads it.
import type * as cf from "@cloudflare/workers-types";
import { text, type Input } from "@notation/resource";
import {
  $durableObject,
  $worker,
  addBindings,
  worker,
  type WorkerEnv,
} from "src/workers";

declare const WorkerEntrypoint: typeof cf.CloudflareWorkersModule.WorkerEntrypoint;
declare const DurableObject: typeof cf.CloudflareWorkersModule.DurableObject;

export const api = $worker({ id: "api", compatibilityDate: "2026-10-12" });

export const app = worker({
  id: "app",
  compatibilityDate: "2026-10-12",
  code: { type: "file", path: "dist/app.mjs" },
});

export const github = $worker({
  id: "github",
  compatibilityDate: "2026-10-12",
  url: false,
});

// A namespace whose container names the Worker that binds it. The return
// type of `environmentVariables` is annotated, or the types of the two
// would depend on each other.
export class Room extends DurableObject {}

export const rooms = $durableObject({
  id: "rooms",
  class: Room,
  container: {
    image: { context: "containers/room" },
    maxInstances: 1,
    environmentVariables: (): Record<string, Input<string>> => ({
      ROUTER_URL: text`${router.url}/callback`,
    }),
  },
});

export const router = $worker({
  id: "router",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ROOMS: rooms }),
});

// Bound in one direction through `bindings` and in the other through
// addBindings(), as in 0023, with each other's URL and its own.
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

export const caller = $worker({
  id: "caller",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ REPORTS: reports, REPORTS_URL: reports.url }),
});

addBindings(reports, { CALLER: caller, CALLER_URL: caller.url });
addBindings(caller, { OWN_URL: caller.url });
