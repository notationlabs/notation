import { expect, it } from "vitest";
import { decideDriftAction } from "@notation/reconciler";
import {
  WorkerScript,
  type ScriptObservability,
  type TailConsumer,
} from "src/resources/workers/worker-script";
import {
  accountId,
  describeE2e,
  poll,
  useProject,
  versionIds,
} from "../../e2e";

// Long enough that deploy cuts the generated name to the 54 character limit.
const id = "scriptworkerwithanidlongerthanthenamelimit";

// A Worker that binds itself. "/self" calls the Worker through the binding.
const workerModule = (reply: string) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ SELF: worker }),
  });

  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/self") {
        return new Response("self: " + (await (await env.SELF.fetch(new URL("/", url))).text()));
      }
      return new Response("${reply}");
    },
  } satisfies WorkerHandler<typeof worker>;
`;

describeE2e("WorkerScript", () => {
  const project = useProject();
  let name: string;

  it("creates a Worker whose generated name is cut to 54 characters", async () => {
    project.write("runtime/worker.ts", workerModule("v1"));
    await project.notation("deploy");

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    name = names[0]!;
    expect(name).toMatch(
      new RegExp(`^${project.scope}scriptworker[a-z]+-[0-9a-f]{8}$`),
    );
    expect(name).toHaveLength(54);
    expect(await poll(`${project.url(name)}/`)).toMatchObject({
      ok: true,
      body: "v1",
    });
  });

  it("creates a Worker that binds itself in one upload", async () => {
    expect(await versionIds(name)).toHaveLength(1);
    expect(await poll(`${project.url(name)}/self`)).toMatchObject({
      ok: true,
      body: "self: v1",
    });
  });

  it("uploads a new version of the Worker, under the same name, when its code changes", async () => {
    project.write("runtime/worker.ts", workerModule("v2"));
    await project.notation("deploy");

    expect(await project.workerNames()).toEqual([name]);
    expect(await versionIds(name)).toHaveLength(2);
    expect(
      await poll(`${project.url(name)}/`, {
        done: (fetched) => fetched.body === "v2",
      }),
    ).toMatchObject({ ok: true, body: "v2" });
  });
});

// A Worker with no log options.
const plainModule = `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

  export const plain = $worker({
    id: "plain",
    compatibilityDate: "2026-10-12",
    url: false,
  });

  export default {
    async fetch() {
      return new Response("plain");
    },
  } satisfies WorkerHandler<typeof plain>;
`;

// A Tail Worker.
const sinkModule = `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

  export const sink = $worker({
    id: "sink",
    compatibilityDate: "2026-10-12",
    url: false,
  });

  export default {
    async tail(events) {
      console.log(events.length);
    },
  } satisfies WorkerHandler<typeof sink>;
`;

// A Worker that sends its logs to Workers Logs, Logpush and the Tail Worker.
const producerModule = `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { sink } from "./sink";

  export const producer = $worker({
    id: "producer",
    compatibilityDate: "2026-10-12",
    url: false,
    observability: { enabled: true, headSamplingRate: 0.5 },
    logpush: true,
    tailConsumers: () => [sink],
  });

  export default {
    async fetch() {
      return new Response("producer");
    },
  } satisfies WorkerHandler<typeof producer>;
`;

const script = new WorkerScript("worker:logs", {
  config: { CompatibilityDate: "2026-10-12" },
  dependencies: {} as any,
});

describeE2e("WorkerScript log settings", () => {
  const project = useProject({ stage: "logs" });

  const nameOf = async (id: string) => {
    const name = (await project.workerNames()).find((found) =>
      found.startsWith(`${project.scope}${id}-`),
    );
    expect(name).toBeDefined();
    return name!;
  };

  // Reads the Worker with the log params that `$worker` gives it, and
  // returns the read and the drift decision.
  const readLogs = async (
    name: string,
    logs: {
      Observability: ScriptObservability;
      Logpush: boolean;
      TailConsumers: TailConsumer[];
    },
  ) => {
    const params = { AccountId: accountId, ScriptName: name, ...logs };
    const read = await script.read!(
      { AccountId: accountId, ScriptName: name },
      undefined,
      params as any,
    );
    const action = decideDriftAction({
      resource: script,
      params,
      driftRead: { kind: "present", output: read },
    });
    return { read, action };
  };

  it("turns each log setting off for a Worker with no log options", async () => {
    project.write("runtime/plain.ts", plainModule);
    await project.notation("deploy");

    const off = {
      Observability: { enabled: false } as const,
      Logpush: false,
      TailConsumers: [],
    };
    const { read, action } = await readLogs(await nameOf("plain"), off);
    expect(read).toMatchObject(off);
    expect(action).toEqual({ decision: "noop" });
  });

  it("reads Workers Logs, Logpush and a tail consumer as they were deployed, with no drift", async () => {
    project.write("runtime/sink.ts", sinkModule);
    project.write("runtime/producer.ts", producerModule);
    await project.notation("deploy");

    const logs = {
      Observability: { enabled: true, head_sampling_rate: 0.5 } as const,
      Logpush: true,
      TailConsumers: [{ service: await nameOf("sink") }],
    };
    const { read, action } = await readLogs(await nameOf("producer"), logs);
    expect(read).toMatchObject(logs);
    expect(action).toEqual({ decision: "noop" });
  });
});
