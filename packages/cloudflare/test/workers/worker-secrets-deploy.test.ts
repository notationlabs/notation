import { randomUUID } from "node:crypto";
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
  type ReconcilerEvent,
} from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import {
  collectResourceGraph,
  declaredIn,
  type CredentialRef,
} from "@notation/resource";
import * as std from "@notation/std/resources";
import * as cloudflare from "src/resources";
import { $worker } from "src/workers";
import { loads, sourceValues, TestSource } from "../fixtures/test-source";

const compatibilityDate = "2026-10-12";
const scope = { app: "shop", stage: "dev" };

type FakeWorker = {
  code: string;
  secrets: Map<string, string>;
};

type FakeDeployment = {
  versions: { version_id: string; percentage: number }[];
};

let directory: string;
let runtime: NodeDurableRuntime;
let workers: Map<string, FakeWorker>;
// The deployments that the fake API reports, by Worker name, latest first.
// A Worker with none listed has one deployment of one version.
let deployments: Map<string, FakeDeployment[]>;
// The writes that reached the fake API, in order.
let log: string[];
let events: ReconcilerEvent[];

const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });
const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

// The Workers API of one account, with only the routes that deploy and
// destroy of a Worker with secrets use. An upload keeps each secret that it
// leaves out, as Cloudflare does.
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
      const secrets = new Map(worker?.secrets);
      const sent: string[] = [];
      for (const binding of metadata.bindings) {
        if (binding.type !== "secret_text") continue;
        secrets.set(binding.name, binding.text);
        sent.push(binding.name);
      }
      log.push(
        `upload ${name}${sent.length ? ` with ${sent.sort().join(",")}` : ""}`,
      );
      workers.set(name, { code, secrets });
      return ok({});
    }
    if (!worker) return fail(404, 10007, "This Worker does not exist");
    if (method === "GET" && sub === "settings") {
      return ok({
        compatibility_date: compatibilityDate,
        compatibility_flags: ["nodejs_compat"],
      });
    }
    if (method === "GET" && sub === "deployments") {
      const listed = deployments.get(name) ?? [
        { versions: [{ version_id: "v1", percentage: 100 }] },
      ];
      return ok({
        deployments: listed.map((deployment, index) => ({
          id: `d${index}`,
          ...deployment,
        })),
      });
    }
    if (method === "DELETE" && sub === "") {
      log.push(`delete ${name}`);
      workers.delete(name);
      return ok(null);
    }
    if (method === "GET" && sub === "secrets") {
      return ok(
        [...worker.secrets.keys()].map((name) => ({
          name,
          type: "secret_text",
        })),
      );
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

// The bindings of the Worker "api" in the next collect.
let bindings: "none" | "both" | "apiKey" | "admin";
let workerId: string;

const declareWorker = () => {
  const apiKey = new TestSource("api-key", { config: { key: "API_KEY" } });
  const admin = new TestSource("admin", { config: { key: "ADMIN" } });
  const all = {
    API_KEY: apiKey.credentials.value,
    ADMIN: admin.credentials.value,
  };
  const chosen: Record<string, CredentialRef<string>> = bindings === "none"
    ? {}
    : bindings === "both"
      ? all
      : bindings === "apiKey"
        ? { API_KEY: all.API_KEY }
        : { ADMIN: all.ADMIN };
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

let infra: () => void;

const collect = () => collectResourceGraph(infra, { scope });

const registry = createResourceRegistry([
  cloudflare.workers.WorkerScript,
  std.fs.File,
]);

async function deploy(executionId: string) {
  const { resources } = await collect();
  await runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, id) =>
      durable.deploy(step, {
        executionId: id,
        resources,
        registry,
        state: runtime.state,
        ...scope,
        emit: (event) => void events.push(event),
      }),
  );
}

async function destroy(executionId: string) {
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
}

async function decisions() {
  const { resources } = await collect();
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

// Gives the value of `key` a new revision. Deploy holds a value for the life
// of the process, by its version, so each revision is unique, and no test
// finds the value of another.
const setValue = (key: string, value: string) =>
  sourceValues.set(key, { value, revision: randomUUID() });

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
  deployments = new Map();
  log = [];
  events = [];
  bindings = "both";
  workerId = "api";
  sourceValues.clear();
  setValue("API_KEY", "sk_live");
  setValue("ADMIN", "hunter2");
  loads.length = 0;
  infra = declareWorker;
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
  it("uploads the code with its secrets in one request, and records a marker for each value", async () => {
    await deploy("first");

    const name = onlyWorker();
    expect(name).toMatch(/^shop--dev--api-[0-9a-f]{8}$/);
    expect(log).toEqual([`upload ${name} with ADMIN,API_KEY`]);
    expect(workers.get(name)!.secrets).toEqual(
      new Map([
        ["API_KEY", "sk_live"],
        ["ADMIN", "hunter2"],
      ]),
    );
    const record = await runtime.state.get("worker:api");
    expect(record?.params.Secrets).toEqual({
      ADMIN: {
        $credential: {
          resource: "admin",
          name: "value",
          version: expect.any(String),
        },
      },
      API_KEY: {
        $credential: {
          resource: "api-key",
          name: "value",
          version: expect.any(String),
        },
      },
    });
    const values = await runtime.state.values();
    expect(JSON.stringify(values)).not.toMatch(/sk_live|hunter2/);

    expect((await decisions())["worker:api"]).toBe("noop");
  });

  it("keeps the name of a live Worker that gains its first secret", async () => {
    bindings = "none";
    await deploy("first");
    const name = onlyWorker();
    log = [];

    bindings = "apiKey";
    expect((await decisions())["worker:api"]).toBe("update");
    await deploy("second");

    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`upload ${name} with API_KEY`]);
  });

  it("sends only the secrets whose credential has a new version, and keeps the others", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await deploy("second");
    expect(log).toEqual([`upload ${name}`]);

    setValue("API_KEY", "sk_rotated");
    expect((await decisions())["worker:api"]).toBe("update");
    loads.length = 0;
    await deploy("third");

    expect(loads).toEqual(["API_KEY"]);
    expect(log).toEqual([`upload ${name}`, `upload ${name} with API_KEY`]);
    expect(workers.get(name)!.secrets).toEqual(
      new Map([
        ["API_KEY", "sk_rotated"],
        ["ADMIN", "hunter2"],
      ]),
    );
  });

  it("sends a secret deleted outside notation again on the next deploy", async () => {
    await deploy("first");
    const name = onlyWorker();
    workers.get(name)!.secrets.delete("ADMIN");
    log = [];

    expect((await decisions())["worker:api"]).toBe("drift-update");
    await deploy("second");

    expect(log).toEqual([`upload ${name} with ADMIN`]);
    expect(workers.get(name)!.secrets.get("ADMIN")).toBe("hunter2");
  });

  it("deletes a removed secret after the upload, and keeps the name when the last secret goes", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];

    bindings = "apiKey";
    await deploy("second");
    expect(log).toEqual([`upload ${name}`, `delete secret ADMIN on ${name}`]);

    log = [];
    bindings = "none";
    await deploy("third");
    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`upload ${name}`, `delete secret API_KEY on ${name}`]);
    expect(workers.get(name)!.secrets.size).toBe(0);
  });

  it("gives a Worker whose id changes a new name with its secrets, and sweeps the old one", async () => {
    await deploy("first");
    const before = onlyWorker();
    log = [];

    workerId = "web";
    await deploy("second");

    const after = onlyWorker();
    expect(after).toMatch(/^shop--dev--web-[0-9a-f]{8}$/);
    expect(log).toEqual([
      `upload ${after} with ADMIN,API_KEY`,
      `delete ${before}`,
    ]);
  });

  it("destroys the Worker with its secrets in one delete", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];

    await destroy("destroy");

    expect(workers.size).toBe(0);
    expect(log).toEqual([`delete ${name}`]);
  });
});

describe("a gradual rollout", () => {
  it("fails a deploy that would upload the Worker during a rollout, and uploads nothing", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];
    deployments.set(name, [
      {
        versions: [
          { version_id: "3c9e", percentage: 50 },
          { version_id: "81fa", percentage: 50 },
        ],
      },
      { versions: [{ version_id: "3c9e", percentage: 100 }] },
    ]);

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await expect(deploy("second")).rejects.toThrow(
      `The Worker ${name} is in a gradual rollout: 50% on version 3c9e, 50% on version 81fa. An upload would end the rollout. Finish or cancel it in Cloudflare, then deploy again.`,
    );
    expect(log).toEqual([]);
  });

  it("fails a change of a secret alone during a rollout", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];
    deployments.set(name, [
      {
        versions: [
          { version_id: "3c9e", percentage: 90 },
          { version_id: "81fa", percentage: 10 },
        ],
      },
    ]);

    bindings = "apiKey";
    await expect(deploy("second")).rejects.toThrow("is in a gradual rollout");
    expect(log).toEqual([]);
  });

  it("uploads when the latest deployment has one version", async () => {
    await deploy("first");
    const name = onlyWorker();
    log = [];
    deployments.set(name, [
      { versions: [{ version_id: "81fa", percentage: 100 }] },
      {
        versions: [
          { version_id: "3c9e", percentage: 50 },
          { version_id: "81fa", percentage: 50 },
        ],
      },
    ]);

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await deploy("second");
    expect(log).toEqual([`upload ${name}`]);
  });
});
