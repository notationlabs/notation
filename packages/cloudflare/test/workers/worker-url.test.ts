import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  declaredIn,
  deployLookup,
  OutputRefStringError,
  resolveOutputRefs,
  resource,
  text,
  UNKNOWN_AFTER_APPLY,
  type Input,
  type OutputRef,
  type ResourceGraph,
} from "@notation/resource";
import { kvJson } from "src/kv";
import { kv } from "src/resources";
import {
  $durableObject,
  $worker,
  isWorkerGroup,
  worker,
  type WorkerGroup,
} from "src/workers";
import type * as fixtures from "../fixtures/url-workers";

const compatibilityDate = "2026-10-12";

// Records the module of a declaration, as the infra build does.
const inWorker = <T>(declaration: T, file: string, exports: string[] = []) =>
  declaredIn(declaration, file, "worker", { exports, starExports: [] });
const inModule = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "namespace");

class Room {}

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

function group(graph: ResourceGraph, id: string): WorkerGroup {
  const found = graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  );
  if (!found) throw new Error(`No Worker group ${id} in the graph`);
  return found as WorkerGroup;
}

const nameOf = (id: string) => `shop--dev--${id}-1a2b3c4d`;
const urlOf = (id: string) => `https://${nameOf(id)}.acme.workers.dev`;

// Gives a Worker the outputs that deploy gives it: its bundle, its script
// and its subdomain.
function deployed(worker: WorkerGroup) {
  worker.code.setOutput({
    filePath: `dist/runtime/${worker.id}/index.mjs`,
    sourceSha256: "hex",
    fileSha256: "sha",
  });
  worker.script.setOutput({
    AccountId: "account",
    ScriptName: nameOf(worker.id),
  } as any);
  worker.subdomain?.setOutput({
    AccountId: "account",
    ScriptName: nameOf(worker.id),
    Url: urlOf(worker.id),
  });
}

async function scriptParams(worker: WorkerGroup) {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
  try {
    return await worker.script.getParams();
  } finally {
    vi.unstubAllEnvs();
  }
}

const Webhook = resource<{
  Key: { Id: string };
  CreateParams: { Url: string };
  UpdateParams: { Url: string };
  ReadResult: { Id: string };
}>({ type: "test/worker-url/webhook", provider: "test" })
  .defineSchema({
    Id: {
      propertyType: "computed",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
    Url: { propertyType: "param", presence: "required", value: v.string() },
  })
  .defineOperations({
    create: async () => ({ Id: "1" }),
    update: async () => undefined,
    delete: async () => undefined,
  });

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-worker-url-"));
  setConfigFile(path.join(directory, "notation.config.ts"));
  await writeFile(
    path.join(directory, "router.mjs"),
    "export class Room {}\nexport default { fetch: () => new Response('ok') };\n",
  );
});

afterEach(async () => {
  setConfigFile(undefined);
  await rm(directory, { recursive: true, force: true });
});

describe("url", () => {
  it("makes a resource that holds it in text depend on the subdomain, and plans as unknown before the first deploy", async () => {
    let webhook!: InstanceType<typeof Webhook>;
    const graph = await collect(() => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      webhook = new Webhook("deploys", {
        config: { Url: text`${api.url}/github/webhook` },
      });
    });
    const api = group(graph, "api");

    expect(webhook.getDependencies()).toEqual([api.subdomain]);
    expect(await webhook.planParams()).toEqual({ Url: UNKNOWN_AFTER_APPLY });
    deployed(api);
    expect(await webhook.getParams()).toEqual({
      Url: `${urlOf("api")}/github/webhook`,
    });
  });

  it("returns the same ref on each read, which names the subdomain's Url", async () => {
    await collect(() => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      expect(api.url).toBe(api.url);
      expect(api.url.resourceId).toBe("worker:api:subdomain");
      expect(api.url.path).toEqual(["Url"]);
    });
  });

  it("is a property of worker(), and not an enumerable one", async () => {
    let webhook!: InstanceType<typeof Webhook>;
    const graph = await collect(() => {
      const app = worker({
        id: "router",
        compatibilityDate,
        code: { type: "file", path: path.join(directory, "router.mjs") },
      });
      expect(Object.keys(app)).toEqual(["id"]);
      webhook = new Webhook("deploys", { config: { Url: app.url } });
    });

    expect(webhook.getDependencies()).toEqual([
      group(graph, "router").subdomain,
    ]);
  });

  it("leaves the other keys of a kvJson() document known at plan", async () => {
    let flags!: ReturnType<typeof kvJson>;
    const graph = await collect(() => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      const namespace = new kv.KVNamespace("config", {
        config: { Title: "config" },
      });
      flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: v.object({
          features: v.record(v.string(), v.boolean()),
          endpoints: v.record(v.string(), v.string()),
        }),
        value: { features: { uploads: true } },
      });
      flags.contribute({ endpoints: { api: api.url } });
    });

    expect((await flags.value.planParams()).Value).toEqual({
      features: { uploads: true },
      endpoints: { api: UNKNOWN_AFTER_APPLY },
    });
    deployed(group(graph, "api"));
    expect((await flags.value.planParams()).Value).toEqual({
      features: { uploads: true },
      endpoints: { api: urlOf("api") },
    });
  });

  it("throws OutputRefStringError with the subdomain's Url when it is turned into a string while the modules load, without resolving the ref", async () => {
    await collect(() => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      let error: unknown;
      try {
        new URL(api.url as unknown as string);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OutputRefStringError);
      expect((error as Error).message).toMatch(
        /^Output worker:api:subdomain\.Url:/,
      );
      expect(() => api.url.resource).toThrow(
        /was read while the infra modules load/,
      );
    });
  });

  it("is a type error, and throws, for a Worker with url: false", async () => {
    await collect(() => {
      const github = inWorker(
        $worker({ id: "github", compatibilityDate, url: false }),
        "runtime/github.ts",
      );
      // @ts-expect-error a Worker with url: false has no url
      expect(() => github.url).toThrow(
        'url was read on $worker({ id: "github" }) in runtime/github.ts, which sets url: false, so it has no workers.dev URL. Remove url: false, or bind the Worker as a service.',
      );
    });
  });

  it("throws for a Worker that is declared while no resource graph is being collected", () => {
    const api = $worker({ id: "api", compatibilityDate });
    expect(() => api.url).toThrow(
      'url was read on $worker({ id: "api" }), which was declared while no resource graph is being collected. Declare the Worker in an infra module, while the infra modules load.',
    );
  });

  it("throws at evaluation for a url option that is a boolean but not a literal", async () => {
    const serve = false as boolean;
    await collect(() => {
      const github = inWorker(
        $worker({ id: "github", compatibilityDate, url: serve }),
        "runtime/github.ts",
      );
      expectTypeOf<typeof github.url>().toEqualTypeOf<OutputRef<string>>();
      expect(() => github.url).toThrow(/sets url: false/);
    });
  });
});

describe("URL bindings", () => {
  it("contributes a binding to another Worker's URL, which depends on its subdomain", async () => {
    const graph = await collect(() => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({
            API_URL: api.url,
            CALLBACK: text`${api.url}/callback`,
          }),
        }),
        "runtime/web.ts",
      );
    });
    const api = group(graph, "api");
    const web = group(graph, "web");

    expect(web.script.config.Bindings).toEqual([]);
    expect(web.script.getFixedDependencies()).not.toContain(api.subdomain);
    expect(web.script.getDependencies()).toContain(api.subdomain);
    expect(web.script.getContributedParams()).toEqual(["Bindings"]);
    deployed(api);
    web.code.setOutput({
      filePath: "dist/runtime/web/index.mjs",
      sourceSha256: "hex",
      fileSha256: "sha",
    });
    expect((await scriptParams(web)).Bindings).toEqual([
      { type: "plain_text", name: "API_URL", text: urlOf("api") },
      {
        type: "plain_text",
        name: "CALLBACK",
        text: `${urlOf("api")}/callback`,
      },
    ]);
  });
});

describe("environmentVariables as a function", () => {
  const container = (env: () => Record<string, Input<string>>) => ({
    image: { context: "containers/room" },
    maxInstances: 1,
    environmentVariables: env,
  });

  it("names the hosting Worker in a package's function", async () => {
    // A package's function, as in the router example.
    function router({ id, file }: { id: string; file: string }) {
      const app = worker({
        id,
        compatibilityDate,
        code: { type: "file", path: file },
        bindings: () => ({ ROOMS: rooms }),
      });
      const rooms = inModule(
        $durableObject({
          id: `${id}-rooms`,
          class: Room,
          container: container((): Record<string, Input<string>> => ({
            ROUTER_URL: text`${app.url}/callback`,
          })),
        }),
        "node_modules/@acme/router/infra/router.ts",
      );
      return { worker: app, url: app.url };
    }

    const graph = await collect(() => {
      router({ id: "api", file: path.join(directory, "router.mjs") });
    });
    const api = group(graph, "api");
    const [{ application }] = api.containers as [WorkerGroup["containers"][0]];

    expect(application.getDependencies()).toContain(api.subdomain);
    deployed(api);
    expect(
      resolveOutputRefs(
        (application.config.Configuration as any).environment_variables,
        deployLookup,
      ),
    ).toEqual([{ name: "ROUTER_URL", value: `${urlOf("api")}/callback` }]);
  });

  it("names a Worker that is declared after the namespace, in a module that imports the namespace's module", async () => {
    // Stands for two modules that import each other: room.ts runs first, so
    // `router` is not initialized while it runs.
    const modules: { router?: { url: OutputRef<string> } } = {};
    const graph = await collect(() => {
      const rooms = inModule(
        $durableObject({
          id: "rooms",
          class: Room,
          container: container(() => ({ ROUTER_URL: modules.router!.url })),
        }),
        "runtime/room.ts",
      );
      modules.router = inWorker(
        $worker({
          id: "router",
          compatibilityDate,
          bindings: () => ({ ROOMS: rooms }),
        }),
        "runtime/router.ts",
        ["Room"],
      );
    });
    const router = group(graph, "router");
    const [{ application }] = router.containers as [
      WorkerGroup["containers"][0],
    ];

    expect(application.getDependencies()).toContain(router.subdomain);
    expect(router.subdomain!.getDependencies()).not.toContain(application);
  });
});

describe("types", () => {
  it("types url as an OutputRef<string>", () => {
    expectTypeOf<(typeof fixtures.api)["url"]>().toEqualTypeOf<
      OutputRef<string>
    >();
    expectTypeOf<(typeof fixtures.app)["url"]>().toEqualTypeOf<
      OutputRef<string>
    >();
    expectTypeOf<typeof fixtures.github>().not.toHaveProperty("url");
  });

  it("types a namespace whose environmentVariables function names the Worker that binds it, and the cycles of 0023", () => {
    expectTypeOf<(typeof fixtures.router)["url"]>().toEqualTypeOf<
      OutputRef<string>
    >();
    expectTypeOf<typeof fixtures.rooms>().toHaveProperty("id");
    expectTypeOf<(typeof fixtures.reports)["url"]>().toEqualTypeOf<
      OutputRef<string>
    >();
  });
});
