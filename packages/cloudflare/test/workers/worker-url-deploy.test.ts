import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  runDurableWorkflow,
  setConfigFile,
} from "@notation/core";
import {
  createPlan,
  createResourceRegistry,
  instanceHash,
  type Overrides,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph, declaredIn } from "@notation/resource";
import * as std from "@notation/std/resources";
import * as cloudflare from "src/resources";
import { $worker, addBindings } from "src/workers";

const compatibilityDate = "2026-10-12";
const scope = { app: "shop", stage: "dev" };

type FakeWorker = {
  // The plain text bindings of the last upload, by name.
  text: Record<string, string>;
  served: boolean;
};

let directory: string;
let runtime: NodeDurableRuntime;
let workers: Map<string, FakeWorker>;
// The writes that reached the fake API, in order.
let log: string[];

const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });
const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

// The Workers API of one account whose workers.dev subdomain is "acme", with
// only the routes that deploy of a Worker with a workers.dev URL uses.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/client/v4/accounts/acc/workers/subdomain") {
      return ok({ subdomain: "acme" });
    }
    if (url.pathname.startsWith("/client/v4/accounts/acc/workers/tails/")) {
      return ok([]);
    }
    const route = url.pathname.replace(
      "/client/v4/accounts/acc/workers/scripts",
      "",
    );
    if (route === "" && method === "GET") {
      return ok([...workers.keys()].map((id) => ({ id })));
    }
    const [, encoded, ...rest] = route.split("/");
    const name = decodeURIComponent(encoded!);
    const sub = rest.map(decodeURIComponent).join("/");
    const worker = workers.get(name);
    if (method === "PUT" && sub === "") {
      const form = init!.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata")));
      const text: Record<string, string> = {};
      for (const binding of metadata.bindings) {
        if (binding.type === "plain_text") text[binding.name] = binding.text;
      }
      const names = Object.keys(text).sort();
      log.push(`upload ${name}${names.length ? ` with ${names}` : ""}`);
      workers.set(name, { text, served: worker?.served ?? false });
      return ok({});
    }
    if (!worker) return fail(404, 10007, "This Worker does not exist");
    if (method === "DELETE" && sub === "") {
      log.push(`delete ${name}`);
      workers.delete(name);
      return ok({});
    }
    if (method === "GET" && sub === "references") return ok({});
    if (method === "GET" && sub === "settings") {
      return ok({
        compatibility_date: compatibilityDate,
        compatibility_flags: ["nodejs_compat"],
      });
    }
    if (method === "GET" && sub === "deployments") {
      return ok({
        deployments: [
          { id: "d0", versions: [{ version_id: "v1", percentage: 100 }] },
        ],
      });
    }
    if (sub === "subdomain" && method === "GET") {
      return ok({ enabled: worker.served });
    }
    if (sub === "subdomain" && method === "POST") {
      const { enabled } = JSON.parse(String(init!.body));
      log.push(`serve ${name}`);
      worker.served = enabled;
      return ok({ enabled });
    }
    return fail(400, 1001, `unexpected ${method} ${url.pathname}`);
  });
}

const inWorker = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "worker", { exports: [], starExports: [] });

let infra: () => void;

const registry = createResourceRegistry([
  cloudflare.workers.WorkerScript,
  cloudflare.workers.WorkerSubdomain,
  std.fs.File,
]);

async function deploy(executionId: string, overrides?: Overrides) {
  const { resources } = await collectResourceGraph(infra, { scope });
  await runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, id) =>
      durable.deploy(step, {
        executionId: id,
        resources,
        registry,
        state: runtime.state,
        ...scope,
        overrides,
        emit: () => {},
      }),
  );
}

async function decisions() {
  const { resources } = await collectResourceGraph(infra, { scope });
  const planned = await createPlan({
    resources,
    state: runtime.state,
    registry,
    app: scope.app,
    stage: scope.stage,
  });
  return Object.fromEntries(
    planned.nodes.map((node) => [node.id, node.decision]),
  );
}

async function writeBundle(id: string) {
  const bundle = path.join(directory, `dist/runtime/${id}/index.mjs`);
  await mkdir(path.dirname(bundle), { recursive: true });
  await writeFile(
    bundle,
    "export default { fetch: () => new Response('ok') };\n",
  );
}

const nameOf = (id: string) => {
  const found = [...workers.keys()].find((name) =>
    name.startsWith(`shop--dev--${id}-`),
  );
  if (!found) throw new Error(`No Worker ${id}`);
  return found;
};
const urlOf = (id: string) => `https://${nameOf(id)}.acme.workers.dev`;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-worker-url-"));
  setConfigFile(path.join(directory, "notation.config.ts"));
  await writeBundle("api");
  await writeBundle("web");
  runtime = new NodeDurableRuntime({
    deployment: scope,
    databasePath: path.join(directory, "workflows.db"),
  });
  workers = new Map();
  log = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  fakeCloudflare();
});

afterEach(async () => {
  runtime.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setConfigFile(undefined);
  await rm(directory, { recursive: true, force: true });
});

describe("a Worker that binds a URL", () => {
  it("binds its own URL with addBindings(), with a second upload on the first deploy", async () => {
    infra = () => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      addBindings(api, { OWN_URL: api.url });
    };

    await deploy("first");

    const api = nameOf("api");
    expect(log).toEqual([
      `upload ${api}`,
      `serve ${api}`,
      `upload ${api} with OWN_URL`,
    ]);
    expect(workers.get(api)!.text).toEqual({ OWN_URL: urlOf("api") });
    expect(await decisions()).toMatchObject({
      "worker:api": "noop",
      "worker:api:subdomain": "noop",
    });
  });

  it("uploads a Worker that binds another Worker's URL once, when they form no cycle", async () => {
    infra = () => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ API_URL: api.url }),
        }),
        "runtime/web.ts",
      );
    };

    await deploy("first");

    const uploads = log.filter((entry) => entry.startsWith("upload"));
    expect(uploads).toEqual([
      `upload ${nameOf("api")}`,
      `upload ${nameOf("web")} with API_URL`,
    ]);
    expect(log.indexOf(`serve ${nameOf("api")}`)).toBeLessThan(
      log.indexOf(`upload ${nameOf("web")} with API_URL`),
    );
  });

  it("updates a Worker that binds another Worker's URL when that Worker is replaced", async () => {
    infra = () => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ API_URL: api.url }),
        }),
        "runtime/web.ts",
      );
    };

    await deploy("first");
    const replaced = nameOf("api");
    const before = urlOf("api");
    expect(workers.get(nameOf("web"))!.text).toEqual({ API_URL: before });

    const { resources } = await collectResourceGraph(infra, { scope });
    const hash = instanceHash(
      runtime.state.deploymentId,
      resources.find(({ id }) => id === "worker:api")!,
      (await runtime.state.get("worker:api"))!,
    );
    await deploy("replace", {
      replace: [{ id: "worker:api", instanceHash: hash }],
    });

    const after = urlOf("api");
    expect(after).not.toBe(before);
    expect(workers.has(replaced)).toBe(false);
    expect(workers.get(nameOf("web"))!.text).toEqual({ API_URL: after });
    expect(Object.values(await decisions())).toEqual(
      expect.not.arrayContaining(["create", "update", "replace"]),
    );
  });

  it("binds the URLs of two Workers that bind each other's", async () => {
    infra = () => {
      const api = inWorker(
        $worker({ id: "api", compatibilityDate }),
        "runtime/api.ts",
      );
      const web = inWorker(
        $worker({
          id: "web",
          compatibilityDate,
          bindings: () => ({ API_URL: api.url }),
        }),
        "runtime/web.ts",
      );
      addBindings(api, { WEB_URL: web.url });
    };

    await deploy("first");

    expect(workers.get(nameOf("api"))!.text).toEqual({
      WEB_URL: urlOf("web"),
    });
    expect(workers.get(nameOf("web"))!.text).toEqual({
      API_URL: urlOf("api"),
    });
    const uploads = log.filter((entry) => entry.startsWith("upload"));
    expect(uploads).toHaveLength(3);
    expect(Object.values(await decisions())).toEqual(
      expect.not.arrayContaining(["create", "update"]),
    );
  });
});
