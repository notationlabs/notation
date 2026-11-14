import { expect, it } from "vitest";
import { describeE2e, namespacesWithPrefix, poll, useProject } from "../e2e";

const counterModule = `
  import { DurableObject } from "cloudflare:workers";
  import { $durableObject } from "@notation/cloudflare/workers";

  export class Counter extends DurableObject {
    async increment() {
      const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
      await this.ctx.storage.put("count", count);
      return count;
    }
  }

  export const counters = $durableObject({ id: "counters", class: Counter });
`;

// A Worker that binds the counters, and exports their class when it hosts
// them.
const workerModule = (id: string, { hosts }: { hosts: boolean }) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { counters } from "./counter";
  ${hosts ? `export { Counter } from "./counter";` : ""}

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ COUNTERS: counters }),
  });

  export default {
    async fetch(request, env) {
      const count = await env.COUNTERS.getByName("one").increment();
      return new Response(\`${id} count=\${count}\`);
    },
  } satisfies WorkerHandler<typeof worker>;
`;

describeE2e("$durableObject", () => {
  const project = useProject();

  // The host Worker hosts the counters, and the guest Worker binds them on
  // the host. `hostHostsCounters: false` swaps the roles.
  function writeProject({ hostHostsCounters }: { hostHostsCounters: boolean }) {
    project.write("runtime/counter.ts", counterModule);
    project.write(
      "runtime/host.ts",
      workerModule("host", { hosts: hostHostsCounters }),
    );
    project.write(
      "runtime/guest.ts",
      workerModule("guest", { hosts: !hostHostsCounters }),
    );
  }

  async function workerNames() {
    const names = await project.workerNames();
    const nameOf = (id: string) => {
      const name = names.find((name) =>
        name.startsWith(`${project.scope}${id}-`),
      );
      if (!name) throw new Error(`No Worker for ${id} among ${names}`);
      return name;
    };
    return { host: nameOf("host"), guest: nameOf("guest") };
  }

  let names: Awaited<ReturnType<typeof workerNames>>;
  let lastCount = 0;

  // Requests a Worker that increments the shared counter, and checks that
  // the count follows the last one, so the counter kept its objects.
  async function expectNextCount(name: string, id: string) {
    const fetched = await poll(`${project.url(name)}/`);
    expect(fetched).toMatchObject({
      ok: true,
      body: expect.stringMatching(new RegExp(`^${id} count=\\d+$`)),
    });
    const count = Number(fetched.body!.split("=")[1]);
    expect(count).toBe(lastCount + 1);
    lastCount = count;
  }

  it("hosts the namespace on the Worker that exports its class, under the Worker's generated name", async () => {
    writeProject({ hostHostsCounters: true });
    await project.notation("deploy");
    names = await workerNames();

    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: names.host, class: "Counter" },
    ]);
  });

  it("serves the same objects to the host and to a Worker that binds the namespace on it", async () => {
    await expectNextCount(names.host, "host");
    await expectNextCount(names.guest, "guest");
  });

  it("moves the namespace, with its objects, to the other Worker", async () => {
    writeProject({ hostHostsCounters: false });
    await project.notation("deploy");

    expect(await workerNames()).toEqual(names);
    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: names.guest, class: "Counter" },
    ]);
    await expectNextCount(names.guest, "guest");
    await expectNextCount(names.host, "host");
  });
});

const sandboxModule = `
  import { DurableObject } from "cloudflare:workers";
  import { $durableObject } from "@notation/cloudflare/workers";

  export class Sandbox extends DurableObject {
    async ping() {
      return "pong";
    }
  }

  export const sandboxes = $durableObject({
    id: "sandboxes",
    class: Sandbox,
    container: true,
  });
`;

const sandboxWorkerModule = `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { sandboxes } from "./sandbox";
  export { Sandbox } from "./sandbox";

  export const worker = $worker({
    id: "api",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ SANDBOXES: sandboxes }),
  });

  export default {
    async fetch(request, env) {
      return new Response(await env.SANDBOXES.getByName("one").ping());
    },
  } satisfies WorkerHandler<typeof worker>;
`;

// Needs the Containers permission and the Workers Paid plan. No container
// application runs containers for the namespace, so the object runs without
// a container.
describeE2e("$durableObject with container: true", () => {
  const project = useProject({ stage: "container" });

  it("uploads the class as a container class, and hosts the namespace", async () => {
    project.write("runtime/sandbox.ts", sandboxModule);
    project.write("runtime/api.ts", sandboxWorkerModule);
    await project.notation("deploy");
    const [name] = await project.workerNames();

    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: name, class: "Sandbox" },
    ]);
    expect(await poll(`${project.url(name!)}/`)).toMatchObject({
      ok: true,
      body: "pong",
    });
  });
});
