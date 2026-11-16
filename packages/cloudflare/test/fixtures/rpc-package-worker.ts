// Only type-checked. The Worker's code in a package, which imports its
// declaration as a type only.
import type * as cf from "@cloudflare/workers-types";
import type { WorkerEnv } from "src/workers";
import type { channel } from "./rpc-package";

declare const WorkerEntrypoint: typeof cf.CloudflareWorkersModule.WorkerEntrypoint;

export default class Channel extends WorkerEntrypoint<
  WorkerEnv<typeof channel>
> {
  async receive(body: string) {
    const name: string = this.env.NAME;
    // @ts-expect-error a name that the Worker doesn't bind
    this.env.MISSING;
    return { name, length: body.length };
  }
}
