import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type * as cf from "@cloudflare/workers-types";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  declaredIn,
  ownPhysicalName,
  type BaseResource,
  type RecordedOutputs,
  type ResourceGraph,
  generatedPhysicalName,
  UNKNOWN_AFTER_APPLY,
} from "@notation/resource";
import { matchesWorkerNames, workerNameRule, workerNames } from "src/id";
import { decideAction, planKnownParams } from "@notation/reconciler";
import { WorkerScript } from "src/resources/workers/worker-script";
import {
  $durableObject,
  $worker,
  isWorkerGroup,
  json,
  workerSecret,
  type WorkerEnv,
  type WorkerGroup,
} from "src/workers";
import * as runtime from "src/workers/runtime";
import { kv, r2 } from "src/resources";
import { env } from "@notation/std/sources";

const projectDir = "/some/project";
const compatibilityDate = "2026-10-12";

beforeEach(() => setConfigFile(`${projectDir}/notation.config.ts`));
afterEach(() => setConfigFile(undefined));

// Records the module of a declaration, as the infra build does. A Worker's
// record also holds the module's other exports.
const inWorker = <T>(
  declaration: T,
  file: string,
  exports: string[] = [],
  starExports: string[] = [],
): T => declaredIn(declaration, file, "worker", { exports, starExports });

const inModule = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "namespace");

// Stands in for a class that extends DurableObject.
class Counter {
  declare readonly __DURABLE_OBJECT_BRAND: never;
  count(): number {
    return 1;
  }
}
class Room {}

function group(graph: ResourceGraph, id: string): WorkerGroup {
  const found = graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  );
  if (!found) throw new Error(`No Worker group ${id} in the graph`);
  return found as WorkerGroup;
}

// The scripts of the graph that `collect` collected last.
let collectedScripts: BaseResource[] = [];

const collect = async (evaluate: () => unknown) => {
  const graph = await collectResourceGraph(evaluate, {
    scope: { app: "shop", stage: "dev" },
  });
  collectedScripts = graph.resources.filter(
    (resource) => resource.type === WorkerScript.type,
  );
  return graph;
};

// The name that deploy generated for a Worker in these tests.
const nameOf = (id: string) => `shop--dev--${id}-1a2b3c4d`;

// The params of a Worker's script at deploy, once its bundle and the Workers
// it binds exist. With `peers`, the params without the contributions that
// depend on them. `recorded` lists the Workers that have a state record.
async function deployParams(
  worker: WorkerGroup,
  bound: WorkerGroup[],
  {
    peers,
    recorded = [],
  }: { peers?: WorkerGroup[]; recorded?: WorkerGroup[] } = {},
) {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
  try {
    worker.code.setOutput({
      filePath: "dist/index.mjs",
      sourceSha256: "hex",
      fileSha256: "sha",
    });
    for (const other of bound) {
      other.script.setOutput({ ScriptName: nameOf(other.id) } as any);
    }
    const recordedOutputs: RecordedOutputs = {};
    for (const resource of collectedScripts) {
      if (!resource.isStateRefTarget()) continue;
      const found = recorded.find((other) => other.script === resource);
      recordedOutputs[resource.id] = found
        ? { ScriptName: nameOf(found.id) }
        : null;
    }
    return await worker.script.getParams({
      recordedOutputs,
      excludeContributionsFrom:
        peers && new Set(peers.map((peer) => peer.script)),
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("$worker", () => {
  it("uploads the runtime bundle of its module, with nodejs_compat", async () => {
    const graph = await collect(() => {
      inWorker($worker({ id: "api", compatibilityDate }), "runtime/api.ts");
    });
    const api = group(graph, "api");

    expect(api.code.config).toEqual({
      filePath: "dist/runtime/api/index.mjs",
    });
    expect(api.script.config).toEqual({
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["nodejs_compat"],
      Bindings: [],
      DurableObjectNamespaces: [],
      BoundDurableObjects: [],
    });
    expect(api.subdomain?.dependencies.script).toBe(api.script);
  });

  it("applies the compatibility settings and url options", async () => {
    const graph = await collect(() => {
      inWorker(
        $worker({
          id: "api",
          compatibilityDate: "2026-01-01",
          compatibilityFlags: ["nodejs_compat", "streams_enable_constructors"],
          url: false,
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");

    expect(api.script.config).toMatchObject({
      CompatibilityDate: "2026-01-01",
      CompatibilityFlags: ["nodejs_compat", "streams_enable_constructors"],
    });
    expect(api.subdomain).toBeUndefined();
  });

  it("binds strings as plain text and other Workers as services", async () => {
    const graph = await collect(() => {
      const auth = inWorker(
        $worker({ id: "auth", compatibilityDate }),
        "runtime/auth.ts",
      );
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ GREETING: "hello", AUTH: auth }),
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");
    const auth = group(graph, "auth");

    expect(api.script.config.Bindings).toEqual([
      { type: "plain_text", name: "GREETING", text: "hello" },
    ]);
    expect(api.script.getDependencies()).toContain(auth.script);
    expect(await deployParams(api, [auth])).toMatchObject({
      Bindings: [
        { type: "plain_text", name: "GREETING", text: "hello" },
        { type: "service", name: "AUTH", service: nameOf("auth") },
      ],
    });
  });

  it("binds an R2 bucket, a KV namespace and a JSON value, and uploads after the bucket and namespace", async () => {
    let uploads!: InstanceType<typeof r2.R2Bucket>;
    let euUploads!: InstanceType<typeof r2.R2Bucket>;
    let cache!: InstanceType<typeof kv.KVNamespace>;
    const graph = await collect(() => {
      uploads = new r2.R2Bucket("uploads", {
        config: {
          BucketName: "uploads",
          Jurisdiction: "default",
          StorageClass: "Standard",
        },
      });
      euUploads = new r2.R2Bucket("eu-uploads", {
        config: {
          BucketName: "eu-uploads",
          Jurisdiction: "eu",
          StorageClass: "Standard",
        },
      });
      cache = new kv.KVNamespace("cache", { config: { Title: "cache" } });
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({
            UPLOADS: uploads,
            EU_UPLOADS: euUploads,
            CACHE: cache,
            CONFIG: json({ retries: 3 }),
          }),
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");

    expect(api.script.getDependencies()).toEqual(
      expect.arrayContaining([uploads, euUploads, cache]),
    );
    uploads.setOutput({ BucketName: "uploads" } as any);
    euUploads.setOutput({ BucketName: "eu-uploads" } as any);
    cache.setOutput({ NamespaceId: "ns1" } as any);
    expect((await deployParams(api, [])).Bindings).toEqual([
      { type: "r2_bucket", name: "UPLOADS", bucket_name: "uploads" },
      {
        type: "r2_bucket",
        name: "EU_UPLOADS",
        bucket_name: "eu-uploads",
        jurisdiction: "eu",
      },
      { type: "kv_namespace", name: "CACHE", namespace_id: "ns1" },
      { type: "json", name: "CONFIG", json: { retries: 3 } },
    ]);
  });

  it("hosts a namespace whose class its module exports", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters }),
        }),
        "runtime/api.ts",
        ["Counter"],
      );
    });
    const api = group(graph, "api");

    expect(api.script.config.Bindings).toEqual([
      {
        type: "durable_object_namespace",
        name: "COUNTERS",
        class_name: "Counter",
      },
    ]);
    expect(api.script.config.DurableObjectNamespaces).toEqual([
      { id: "counters", className: "Counter" },
    ]);
  });

  it("binds a namespace that another Worker hosts on that Worker, and uploads after it", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      inWorker(
        $worker({
          id: "reports",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters }),
        }),
        "runtime/reports.ts",
      );
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters }),
        }),
        "runtime/api.ts",
        ["Counter"],
      );
    });
    const reports = group(graph, "reports");
    const api = group(graph, "api");

    expect(reports.script.config.DurableObjectNamespaces).toEqual([]);
    expect(reports.script.getFixedDependencies()).toContain(api.script);
    expect(await deployParams(reports, [api])).toMatchObject({
      Bindings: [
        {
          type: "durable_object_namespace",
          name: "COUNTERS",
          class_name: "Counter",
          script_name: nameOf("api"),
        },
      ],
      BoundDurableObjects: [
        { id: "counters", className: "Counter", scriptName: nameOf("api") },
      ],
    });
  });

  it("passes the namespaces that a Worker binds on other Workers, and the Workers that bind each hosted namespace", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const rooms = inModule(
        $durableObject({ id: "rooms", class: Room }),
        "runtime/room.ts",
      );
      for (const id of ["web", "reports"]) {
        inWorker(
          $worker({
            id,
            compatibilityDate,
            bindings: () => ({ COUNTERS: counters }),
          }),
          `runtime/${id}.ts`,
        );
      }
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
        }),
        "runtime/api.ts",
        ["Counter", "Room"],
      );
    });
    const api = group(graph, "api");
    const web = group(graph, "web");
    const reports = group(graph, "reports");

    expect(await deployParams(web, [api])).toMatchObject({
      BoundDurableObjects: [
        { id: "counters", className: "Counter", scriptName: nameOf("api") },
      ],
    });
    expect(
      (await deployParams(web, [api])).DurableObjectTransferSources,
    ).toBeUndefined();
    expect(api.script.config.BoundDurableObjects).toEqual([]);
    // The Workers that bind the namespace depend on its host, so the host
    // reads their names from state, with no dependency.
    expect(api.script.getDependencies()).not.toContain(web.script);
    expect(api.script.getDependencies()).not.toContain(reports.script);
    expect(
      (await deployParams(api, [], { recorded: [web] }))
        .DurableObjectTransferSources,
    ).toEqual([
      {
        namespaceId: "counters",
        workerId: "reports",
        scriptName: undefined,
        nameBody: "shop--dev--reports",
      },
      {
        namespaceId: "counters",
        workerId: "web",
        scriptName: nameOf("web"),
        nameBody: "shop--dev--web",
      },
    ]);
  });

  it("passes the ids of hosted namespaces that set protect: false, and undefined when there are none", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const rooms = inModule(
        $durableObject({ id: "rooms", class: Room, protect: false }),
        "runtime/room.ts",
      );
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
        }),
        "runtime/api.ts",
        ["Counter", "Room"],
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ ROOMS: rooms }),
        }),
        "runtime/web.ts",
      );
    });

    expect(group(graph, "api").script.config.UnprotectedDurableObjects).toEqual(
      ["rooms"],
    );
    expect(
      group(graph, "web").script.config.UnprotectedDurableObjects,
    ).toBeUndefined();
  });

  it("declares the class of a namespace that sets container: true as a container class, and leaves container out of other namespaces", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const rooms = inModule(
        $durableObject({ id: "rooms", class: Room, container: true }),
        "runtime/room.ts",
      );
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
        }),
        "runtime/api.ts",
        ["Counter", "Room"],
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ ROOMS: rooms }),
        }),
        "runtime/web.ts",
      );
    });

    expect(group(graph, "api").script.config.DurableObjectNamespaces).toEqual(
      [
        { id: "counters", className: "Counter" },
        { id: "rooms", className: "Room", container: true },
      ],
    );
    expect(group(graph, "web").script.config.DurableObjectNamespaces).toEqual(
      [],
    );
  });

  it("fails for a namespace that no Worker that binds it exports the class of", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        inWorker(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ COUNTERS: counters }),
          }),
          "runtime/api.ts",
          [],
          ["./counter"],
        );
      }),
    ).rejects.toThrow(
      `runtime/api.ts doesn't export Counter, the class of $durableObject({ id: "counters" }) in runtime/counter.ts, which the Worker "api" binds as COUNTERS. Export the class from the Worker's module under that name, as Cloudflare finds the class by its export name, or from the module of another Worker that binds the namespace. The bundle doesn't re-export the names of export * from "./counter", so export Counter by name.`,
    );
  });

  it("fails when two Workers would host the same namespace", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        for (const id of ["api", "reports"]) {
          inWorker(
            $worker({
              id,
              compatibilityDate,
              bindings: () => ({ COUNTERS: counters }),
            }),
            `runtime/${id}.ts`,
            ["Counter"],
          );
        }
      }),
    ).rejects.toThrow(
      `The Workers "api" and "reports" each export Counter and bind $durableObject({ id: "counters" }) in runtime/counter.ts, so each would host the namespace.`,
    );
  });

  it("fails for two namespaces with the same class in one Worker", async () => {
    await expect(
      collect(() => {
        const a = $durableObject({ id: "a", class: Counter });
        const b = $durableObject({ id: "b", class: Counter });
        inWorker(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ A: a, B: b }),
          }),
          "runtime/api.ts",
          ["Counter"],
        );
      }),
    ).rejects.toThrow(
      `hosts the namespaces "a" and "b", which both have the class Counter`,
    );
  });

  it("contributes the service bindings of two Workers that bind each other", async () => {
    const graph = await collect(() => {
      const api: unknown = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ REPORTS: reports }),
        }),
        "runtime/api.ts",
      );
      const reports = inWorker(
        $worker({
          id: "reports",
          compatibilityDate,
          bindings: () => ({ API: api as any }),
        }),
        "runtime/reports.ts",
      );
    });
    const api = group(graph, "api");
    const reports = group(graph, "reports");

    // A contribution is not a fixed dependency, so deploy can create either
    // Worker first without its binding.
    expect(api.script.getDependencies()).toContain(reports.script);
    expect(api.script.getFixedDependencies()).not.toContain(reports.script);
    expect(api.script.getContributedParams()).toEqual(["Bindings"]);
    expect(
      await deployParams(api, [], { peers: [api, reports] }),
    ).toMatchObject({
      Bindings: [],
    });
    expect(await deployParams(api, [reports])).toMatchObject({
      Bindings: [
        { type: "service", name: "REPORTS", service: nameOf("reports") },
      ],
    });
  });

  it("builds a host of a namespace that binds a Worker that binds the namespace on it", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const api: unknown = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, REPORTS: reports }),
        }),
        "runtime/api.ts",
        ["Counter"],
      );
      const reports = inWorker(
        $worker({
          id: "reports",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, API: api as any }),
        }),
        "runtime/reports.ts",
      );
    });
    const api = group(graph, "api");
    const reports = group(graph, "reports");

    expect(reports.script.getFixedDependencies()).toContain(api.script);
    expect(api.script.getFixedDependencies()).not.toContain(reports.script);
    expect(api.script.getDependencies()).toContain(reports.script);
  });

  it("builds a Worker that binds a namespace on a Worker that binds it, when it is declared first", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const reports: unknown = inWorker(
        $worker({
          id: "reports",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, API: api as any }),
        }),
        "runtime/reports.ts",
      );
      const api = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, REPORTS: reports as any }),
        }),
        "runtime/api.ts",
        ["Counter"],
      );
    });
    const api = group(graph, "api");
    const reports = group(graph, "reports");

    expect(reports.script.getFixedDependencies()).toContain(api.script);
    expect(api.script.getFixedDependencies()).not.toContain(reports.script);
    expect(api.script.getDependencies()).toContain(reports.script);
    expect(await deployParams(api, [reports])).toMatchObject({
      Bindings: expect.arrayContaining([
        { type: "service", name: "REPORTS", service: nameOf("reports") },
      ]),
    });
  });

  it("builds a cycle that a service binding closes through a namespace, when a Worker in it is declared first", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const rooms = inModule(
        $durableObject({ id: "rooms", class: Room as any }),
        "runtime/room.ts",
      );
      inWorker(
        $worker({
          id: "a",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
        }),
        "runtime/a.ts",
        ["Room"],
      );
      const x: unknown = inWorker(
        $worker({
          id: "x",
          compatibilityDate,
          bindings: () => ({ ROOMS: rooms }),
        }),
        "runtime/x.ts",
      );
      inWorker(
        $worker({
          id: "h",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, X: x as any }),
        }),
        "runtime/h.ts",
        ["Counter"],
      );
    });
    const h = group(graph, "h");
    const x = group(graph, "x");

    expect(h.script.getFixedDependencies()).not.toContain(x.script);
    expect(h.script.getDependencies()).toContain(x.script);
  });

  it("fails for two Workers that each bind a namespace that the other hosts", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        const rooms = inModule(
          $durableObject({ id: "rooms", class: Room as any }),
          "runtime/room.ts",
        );
        inWorker(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
          }),
          "runtime/api.ts",
          ["Counter"],
        );
        inWorker(
          $worker({
            id: "reports",
            compatibilityDate,
            bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
          }),
          "runtime/reports.ts",
          ["Room"],
        );
      }),
    ).rejects.toThrow(
      `The Workers "api" → "reports" → "api" bind each other's Durable Object namespaces in a cycle.`,
    );
  });

  it("builds a Worker that binds itself", async () => {
    const graph = await collect(() => {
      const api: unknown = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ SELF: api as any }),
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");

    // A ref to the Worker's own name is no dependency. Deploy fills it in
    // with the name before it creates the Worker.
    expect(api.script.getDependencies()).not.toContain(api.script);
    expect(await deployParams(api, [])).toMatchObject({
      Bindings: [
        {
          type: "service",
          name: "SELF",
          service: ownPhysicalName("ScriptName"),
        },
      ],
    });
  });

  it("fails for a binding that a Worker can't bind", async () => {
    await expect(
      collect(() => {
        inWorker(
          $worker({
            id: "api",
            compatibilityDate,
            bindings: () => ({ PORT: 8080 as any }),
          }),
          "runtime/api.ts",
        );
      }),
    ).rejects.toThrow(
      `$worker({ id: "api" }) in runtime/api.ts binds PORT to a value that a Worker can't bind.`,
    );
  });

  it("adds nodejs_compat to the compatibility flags, and sorts them", async () => {
    const graph = await collect(() => {
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          compatibilityFlags: [
            "streams_enable_constructors",
            "nodejs_compat",
            "allow_custom_ports",
          ],
        }),
        "runtime/api.ts",
      );
    });
    expect(group(graph, "api").script.config.CompatibilityFlags).toEqual([
      "allow_custom_ports",
      "nodejs_compat",
      "streams_enable_constructors",
    ]);
  });

  it("fails for a Worker with no compatibility date", () => {
    expect(() => $worker({ id: "api" } as any)).toThrow(
      `$worker({ id: "api" }) requires compatibilityDate, such as "2026-10-12".`,
    );
  });

  it("fails for a Worker that the infra build didn't record", async () => {
    await expect(
      collect(() => {
        $worker({ id: "api", compatibilityDate });
      }),
    ).rejects.toThrow(`The Worker "api" has no module.`);
  });

  it("has no name option", () => {
    // @ts-expect-error deploy generates the Worker's name
    runtime.$worker({ id: "api", compatibilityDate, name: "public-api" });
  });

  it("describes a long id's generated name by the body that deploy cuts it to", async () => {
    const id = "a-very-long-worker-id-that-is-cut-to-fit-the-limit";
    let names: ReturnType<typeof workerNames> | undefined;
    await collect(() => {
      names = workerNames(id);
    });
    const generated = generatedPhysicalName(
      { app: "shop", stage: "dev" },
      `worker:${id}`,
      "1a2b3c4d",
      workerNameRule,
      {},
    );

    expect(generated.length).toBeLessThanOrEqual(54);
    expect(generated).not.toContain(id);
    expect(names).toEqual({
      nameBody: generated.slice(0, -9),
    });
    expect(matchesWorkerNames(generated, names!)).toBe(true);
  });

  it("fails for an id that is not a valid Worker name", async () => {
    await expect(
      collect(() => {
        $worker({ id: "Orders_API", compatibilityDate });
      }),
    ).rejects.toThrow(`Invalid $worker id "Orders_API"`);
  });
});

describe("plan", () => {
  const record = (resource: BaseResource, params: Record<string, unknown>) => ({
    version: 1,
    id: resource.id,
    type: resource.type,
    provider: resource.provider,
    config: {},
    params: params as any,
    output: params as any,
    lastOperation: "create" as const,
    lastOperationAt: "2026-10-12T00:00:00.000Z",
  });

  // A Worker "api" that hosts counters and binds itself, and a Worker "web"
  // that binds counters on it.
  const declare = () =>
    collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      const api: unknown = inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters, SELF: api as any }),
        }),
        "runtime/api.ts",
        ["Counter"],
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ COUNTERS: counters }),
        }),
        "runtime/web.ts",
      );
    });

  // Plans the scripts in their order, as the planner does, with the bundles
  // known, and returns the params of each.
  async function plan(
    graph: ResourceGraph,
    records: Record<string, ReturnType<typeof record>>,
  ) {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    try {
      const state = { get: async (id: string) => records[id] };
      const recordedOutputs: RecordedOutputs = {};
      for (const resource of graph.resources) {
        if (!resource.isStateRefTarget()) continue;
        recordedOutputs[resource.id] =
          (records[resource.id]?.output as any) ?? null;
      }
      const params: Record<string, Record<string, unknown>> = {};
      for (const id of ["api", "web"]) {
        const worker = group(graph, id);
        worker.code.setOutput({
          filePath: `dist/runtime/${id}/index.mjs`,
          sourceSha256: "hex",
          fileSha256: "sha",
        });
        const known = await planKnownParams(
          worker.script,
          state,
          "plan",
          recordedOutputs,
        );
        expect(() =>
          decideAction({
            resource: worker.script,
            stateNode: known.stateNode,
            params: known.params,
          }),
        ).not.toThrow();
        params[id] = known.params;
      }
      return params;
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it("shows the names of Workers that deploy creates as unknown, in each param that holds them", async () => {
    const params = await plan(await declare(), {});

    expect(params.api).toMatchObject({
      ScriptName: UNKNOWN_AFTER_APPLY,
      Bindings: [
        {
          type: "durable_object_namespace",
          name: "COUNTERS",
          class_name: "Counter",
        },
        { type: "service", name: "SELF", service: UNKNOWN_AFTER_APPLY },
      ],
      DurableObjectTransferSources: [
        {
          namespaceId: "counters",
          workerId: "web",
          nameBody: "shop--dev--web",
        },
      ],
    });
    expect(params.web).toMatchObject({
      ScriptName: UNKNOWN_AFTER_APPLY,
      Bindings: [
        {
          type: "durable_object_namespace",
          name: "COUNTERS",
          class_name: "Counter",
          script_name: UNKNOWN_AFTER_APPLY,
        },
      ],
      BoundDurableObjects: [
        {
          id: "counters",
          className: "Counter",
          scriptName: UNKNOWN_AFTER_APPLY,
        },
      ],
    });
  });

  it("reads the names of Workers in state, and the names of the Workers that bind a namespace, from state", async () => {
    const graph = await declare();
    const api = group(graph, "api").script;
    const web = group(graph, "web").script;
    const apiName = nameOf("api");
    const webName = "shop--dev--web";

    const params = await plan(graph, {
      [api.id]: record(api, {
        AccountId: "account",
        ScriptName: apiName,
        CompatibilityDate: compatibilityDate,
      }),
      [web.id]: record(web, {
        AccountId: "account",
        ScriptName: webName,
        CompatibilityDate: compatibilityDate,
      }),
    });

    expect(params.api).toMatchObject({
      ScriptName: apiName,
      Bindings: [
        expect.anything(),
        { type: "service", name: "SELF", service: apiName },
      ],
      DurableObjectTransferSources: [
        expect.objectContaining({
          namespaceId: "counters",
          workerId: "web",
          scriptName: webName,
        }),
      ],
    });
    expect(params.web).toMatchObject({
      ScriptName: webName,
      BoundDurableObjects: [expect.objectContaining({ scriptName: apiName })],
    });
  });
});

describe("runtime", () => {
  it("keeps only the ids of the declarations", () => {
    const counters = runtime.$durableObject({ id: "counters", class: Counter });
    expect(counters).toEqual({ id: "counters" });
    expect(
      runtime.$worker({
        id: "api",
        compatibilityDate,
        bindings: () => ({ COUNTERS: counters }),
      }),
    ).toEqual({ id: "api" });
  });

  it("has the same exports as the infra entry", async () => {
    const infra = await import("src/workers");
    expect(Object.keys(runtime).sort()).toEqual(Object.keys(infra).sort());
  });
});

describe("WorkerEnv", () => {
  it("types each binding from its value", () => {
    const counters = runtime.$durableObject({ id: "counters", class: Counter });
    const auth = runtime.$worker({ id: "auth", compatibilityDate });
    const worker = runtime.$worker({
      id: "api",
      compatibilityDate,
      bindings: () => ({ COUNTERS: counters, AUTH: auth, GREETING: "hi" }),
    });
    type Env = WorkerEnv<typeof worker>;

    expectTypeOf<Env["COUNTERS"]>().toEqualTypeOf<
      cf.DurableObjectNamespace<Counter>
    >();
    expectTypeOf<Env["AUTH"]>().toEqualTypeOf<cf.Fetcher>();
    expectTypeOf<Env["GREETING"]>().toEqualTypeOf<string>();
    // @ts-expect-error a name that the declaration doesn't bind
    type _ = Env["MISSING"];
  });

  it("types R2, KV, JSON and Worker secret bindings", () => {
    const worker = runtime.$worker({
      id: "api",
      compatibilityDate,
      bindings: () => ({
        UPLOADS: {} as InstanceType<typeof r2.R2Bucket>,
        CACHE: {} as InstanceType<typeof kv.KVNamespace>,
        CONFIG: runtime.json({ retries: 3, regions: ["weur"] }),
        API_KEY: {} as ReturnType<typeof workerSecret>,
      }),
    });
    type Env = WorkerEnv<typeof worker>;

    expectTypeOf<Env["UPLOADS"]>().toEqualTypeOf<cf.R2Bucket>();
    expectTypeOf<Env["CACHE"]>().toEqualTypeOf<cf.KVNamespace>();
    expectTypeOf<Env["CONFIG"]>().toEqualTypeOf<{
      retries: number;
      regions: string[];
    }>();
    expectTypeOf<Env["API_KEY"]>().toEqualTypeOf<string>();
  });

  it("lets json() take a value typed as an interface, and no function", () => {
    interface Config {
      retries: number;
      region?: string;
      tags: readonly string[];
    }
    const config: Config = { retries: 3, tags: [] };
    const worker = runtime.$worker({
      id: "api",
      compatibilityDate,
      bindings: () => ({ CONFIG: runtime.json(config) }),
    });

    expectTypeOf<WorkerEnv<typeof worker>["CONFIG"]>().toEqualTypeOf<Config>();
    // @ts-expect-error a function is not a JSON value
    runtime.json({ retries: 3, fetch: () => 1 });
  });

  it("rejects a binding that is another object with an id", () => {
    runtime.$worker({
      id: "api",
      compatibilityDate,
      // @ts-expect-error an object with an id is not a namespace or a Worker
      bindings: () => ({ BUCKET: { id: "uploads" } }),
    });
  });
});
