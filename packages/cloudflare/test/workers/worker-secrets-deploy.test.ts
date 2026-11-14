import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  Redacted,
  runDurableWorkflow,
  runWithSecretContext,
  secretContext,
  setConfigFile,
  type SecretPrompt,
  type Source,
} from "@notation/core";
import {
  createPlan,
  createResourceRegistry,
  type ReconcilerEvent,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph, declaredIn } from "@notation/resource";
import * as std from "@notation/std/resources";
import * as cloudflare from "src/resources";
import { $worker, workerSecret } from "src/workers";
import type { WorkerSecretGroup } from "src/workers/secret";

const compatibilityDate = "2026-10-12";
const scope = { app: "shop", stage: "dev" };

type FakeWorker = { tags: string[]; code: string; secrets: Set<string> };

let directory: string;
let runtime: NodeDurableRuntime;
let workers: Map<string, FakeWorker>;
// The writes that reached the fake API, in order.
let log: string[];
let events: ReconcilerEvent[];
let refuseScriptDelete: boolean;

const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });
const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

// The Workers API of one account, with only the routes that deploy and
// destroy of a Worker with secrets use.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
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
      const code = await (form.get(metadata.main_module) as File).text();
      const tags: string[] = metadata.tags ?? worker?.tags ?? [];
      log.push(`upload ${name}${tags.length ? ` [${tags.join(",")}]` : ""}`);
      workers.set(name, {
        tags,
        code,
        secrets: worker?.secrets ?? new Set(),
      });
      return ok({});
    }
    if (!worker) return fail(404, 10007, "This Worker does not exist");
    if (method === "GET" && sub === "settings") {
      return ok({
        compatibility_date: compatibilityDate,
        compatibility_flags: ["nodejs_compat"],
        tags: worker.tags,
      });
    }
    if (method === "DELETE" && sub === "") {
      if (refuseScriptDelete) return fail(403, 10000, "refused");
      log.push(`delete ${name}`);
      workers.delete(name);
      return ok(null);
    }
    if (method === "PUT" && sub === "secrets") {
      const body = JSON.parse(String(init!.body));
      log.push(`secret ${body.name} on ${name}`);
      worker.secrets.add(body.name);
      return ok({ name: body.name, type: "secret_text" });
    }
    const secret = sub.match(/^secrets\/(.+)$/)?.[1];
    if (secret && method === "GET") {
      return worker.secrets.has(secret)
        ? ok({ name: secret, type: "secret_text" })
        : fail(404, 10056, "binding not found");
    }
    if (secret && method === "DELETE") {
      if (!worker.secrets.has(secret)) return fail(404, 10056);
      log.push(`delete secret ${secret} on ${name}`);
      worker.secrets.delete(secret);
      return ok(null);
    }
    return fail(400, 1001, `unexpected ${method} ${url.pathname}`);
  });
}

const vault: Source = {
  name: "vault",
  has: async () => true,
  get: async () => new Redacted("sk_live"),
};

// The bindings of the Worker "api" in the next collect.
let bindings: "none" | "both" | "sourced" | "prompted";
let workerId: string;

const infra = () => {
  const apiKey = workerSecret({ id: "api-key", source: vault, key: "API_KEY" });
  const admin = workerSecret({ id: "admin" });
  const all = { API_KEY: apiKey, ADMIN: admin };
  const chosen: Record<string, WorkerSecretGroup> =
    bindings === "none"
      ? {}
      : bindings === "both"
        ? all
        : bindings === "sourced"
          ? { API_KEY: apiKey }
          : { ADMIN: admin };
  declaredIn(
    $worker({
      id: workerId,
      compatibilityDate,
      url: false,
      bindings: () => chosen,
    }),
    "runtime/api.ts",
    "worker",
    { exports: [], starExports: [] },
  );
};

const collect = () => collectResourceGraph(infra, { scope });

const registry = createResourceRegistry([
  cloudflare.workers.WorkerScript,
  cloudflare.workers.WorkerScriptPlaceholder,
  cloudflare.workers.WorkerSecret,
  std.fs.File,
  std.sources.SourceValue,
]);

function deploy(executionId: string, prompt?: SecretPrompt) {
  return runWithSecretContext(
    { stage: "dev", runId: executionId, prompt },
    async () => {
      const { resources } = await collect();
      await runDurableWorkflow(
        { workflowId: "deploy", runtime, executionId },
        (step, id) =>
          durable.deploy(step, {
            executionId: id,
            resources,
            registry,
            state: runtime.state,
            nameScope: scope,
            emit: (event) => void events.push(event),
          }),
      );
    },
  );
}

function destroy(executionId: string) {
  return runWithSecretContext(
    { stage: "dev", runId: executionId },
    async () => {
      const { resources } = await collect();
      await runDurableWorkflow(
        { workflowId: "destroy", runtime, executionId },
        (step, id) =>
          durable.destroy(step, {
            executionId: id,
            resources,
            registry,
            state: runtime.state,
            emit: (event) => void events.push(event),
          }),
      );
    },
  );
}

function plan() {
  return runWithSecretContext({ stage: "dev", runId: "plan" }, async () => {
    const { resources } = await collect();
    return createPlan({ resources, state: runtime.state, registry });
  });
}

const deletes = () =>
  events.flatMap((event) =>
    event.event === "reconciler.operation.lifecycle" &&
    event.operation === "delete" &&
    event.status === "start"
      ? [event.resourceId]
      : [],
  );

const prompt = async () => "typed";

async function writeBundle(code: string) {
  const bundle = path.join(directory, "dist/runtime/api/index.mjs");
  await mkdir(path.dirname(bundle), { recursive: true });
  await writeFile(bundle, code);
}

const onlyWorker = () => {
  expect(workers.size).toBe(1);
  return [...workers.keys()][0]!;
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-worker-secrets-"));
  setConfigFile(path.join(directory, "notation.config.ts"));
  await writeBundle("export default { fetch: () => new Response('ok') };\n");
  runtime = new NodeDurableRuntime({
    deployment: scope,
    databasePath: path.join(directory, "workflows.db"),
  });
  workers = new Map();
  log = [];
  events = [];
  refuseScriptDelete = false;
  bindings = "both";
  workerId = "api";
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

describe("a Worker with secrets", () => {
  it("creates a placeholder, then sets the secrets, then uploads the code", async () => {
    await deploy("first", prompt);

    const name = onlyWorker();
    expect(name).toMatch(/^shop--dev--api-[0-9a-f]{8}$/);
    expect(log[0]).toBe(`upload ${name} [notation-placeholder]`);
    expect(log.slice(1, 3).sort()).toEqual([
      `secret ADMIN on ${name}`,
      `secret API_KEY on ${name}`,
    ]);
    expect(log.slice(3)).toEqual([`upload ${name}`]);
    expect(workers.get(name)).toMatchObject({
      tags: [],
      secrets: new Set(["ADMIN", "API_KEY"]),
    });
    for (const id of [
      "worker:api",
      "worker:api:placeholder",
      "worker:api:secret:ADMIN",
    ]) {
      expect((await runtime.state.get(id))?.params).toMatchObject({
        ScriptName: name,
      });
    }

    const planned = await plan();
    expect(
      planned.nodes.find((node) => node.id === "worker:api")?.decision,
    ).toBe("noop");
  });

  it("keeps the name of a live Worker that gains its first secret, and uploads no placeholder", async () => {
    bindings = "none";
    await deploy("first");
    const name = onlyWorker();
    log = [];

    bindings = "sourced";
    const planned = await plan();
    const decisions = Object.fromEntries(
      planned.nodes.map((node) => [node.id, node.decision]),
    );
    // The secret isn't one of the script's params, so the upload is not
    // needed: the write of the secret deploys a new version of the Worker.
    expect(decisions).toMatchObject({
      "worker:api": "noop",
      "worker:api:placeholder": "create",
      "worker:api:secret:API_KEY": "create",
    });
    await deploy("second");

    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`secret API_KEY on ${name}`]);
    expect(
      (await runtime.state.get("worker:api:placeholder"))?.params,
    ).toMatchObject({ ScriptName: name });
  });

  it("deletes a removed secret after the upload, and keeps the name when the last secret goes", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];

    bindings = "sourced";
    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await deploy("second");
    expect(log).toEqual([
      `secret API_KEY on ${name}`,
      `upload ${name}`,
      `delete secret ADMIN on ${name}`,
    ]);

    log = [];
    bindings = "none";
    await deploy("third");
    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`delete secret API_KEY on ${name}`]);
    expect(await runtime.state.get("worker:api:placeholder")).toBeUndefined();
  });

  it("gives a Worker whose id changes a new name, and sweeps the old one", async () => {
    await deploy("first", prompt);
    const before = onlyWorker();
    log = [];

    workerId = "web";
    await deploy("second", prompt);

    const after = onlyWorker();
    expect(after).toMatch(/^shop--dev--web-[0-9a-f]{8}$/);
    expect(log[0]).toBe(`upload ${after} [notation-placeholder]`);
    expect(log).toContain(`upload ${after}`);
    expect(log.at(-1)).toBe(`delete ${before}`);
    expect(await runtime.state.get("worker:api:placeholder")).toBeUndefined();
  });

  it("leaves only the placeholder when a secret without a source has no value, and deploys after secret set", async () => {
    bindings = "prompted";
    await expect(deploy("first")).rejects.toThrow(
      "Secret `admin` isn't set for stage dev",
    );
    const name = onlyWorker();
    expect(log).toEqual([`upload ${name} [notation-placeholder]`]);
    expect(await runtime.state.get("worker:api")).toBeUndefined();

    await runWithSecretContext({ stage: "dev", runId: "set" }, async () => {
      await collect();
      await secretContext()!.declared.get("admin")!.set!("typed");
    });
    expect(workers.get(name)!.secrets).toEqual(new Set(["ADMIN"]));

    log = [];
    await deploy("second");
    expect(log).toEqual([`upload ${name}`]);
    expect(workers.get(name)!.tags).toEqual([]);
  });

  it("destroys the script first, then its secrets, then the placeholder", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];
    events = [];

    await destroy("destroy");

    expect(workers.size).toBe(0);
    expect(log).toEqual([`delete ${name}`]);
    const order = deletes();
    const script = order.indexOf("worker:api");
    const placeholder = order.indexOf("worker:api:placeholder");
    expect(script).toBe(0);
    for (const secret of [
      "worker:api:secret:ADMIN",
      "worker:api:secret:API_KEY",
    ]) {
      expect(order.indexOf(secret)).toBeGreaterThan(script);
      expect(order.indexOf(secret)).toBeLessThan(placeholder);
    }
  });

  it("leaves the secrets alone when the script's delete fails", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];
    events = [];
    refuseScriptDelete = true;

    await expect(destroy("destroy")).rejects.toThrow("refused");

    expect(log).toEqual([]);
    expect(workers.get(name)!.secrets).toEqual(new Set(["ADMIN", "API_KEY"]));
    expect(deletes()).toEqual(["worker:api"]);
    expect(await runtime.state.get("worker:api:secret:ADMIN")).toBeDefined();
  });

  it("deletes a placeholder that the script never replaced", async () => {
    bindings = "prompted";
    await expect(deploy("first")).rejects.toThrow();
    const name = onlyWorker();
    log = [];

    await destroy("destroy");

    expect(log).toEqual([`delete ${name}`]);
    expect(workers.size).toBe(0);
  });
});
