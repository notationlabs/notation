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

type FakeWorker = {
  tags: string[];
  code: string;
  secrets: Map<string, string>;
};

type FakeDeployment = {
  created_on?: string;
  versions: { version_id: string; percentage: number }[];
};

let directory: string;
let runtime: NodeDurableRuntime;
let workers: Map<string, FakeWorker>;
// The deployments that the fake API reports, by Worker name, newest first
// unless they set `created_on`. A Worker with none listed has one
// deployment of one version.
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
      const tags: string[] = metadata.tags ?? worker?.tags ?? [];
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
      workers.set(name, { tags, code, secrets });
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
    if (method === "GET" && sub === "deployments") {
      const listed = deployments.get(name) ?? [
        { versions: [{ version_id: "v1", percentage: 100 }] },
      ];
      return ok({
        deployments: listed.map((deployment, index) => ({
          id: `d${index}`,
          created_on: `2026-11-${19 - index}T00:00:00Z`,
          strategy: "percentage",
          ...deployment,
        })),
      });
    }
    if (method === "DELETE" && sub === "") {
      log.push(`delete ${name}`);
      workers.delete(name);
      return ok(null);
    }
    if (method === "PUT" && sub === "secrets") {
      const body = JSON.parse(String(init!.body));
      log.push(`secret ${body.name} on ${name}`);
      worker.secrets.set(body.name, body.text);
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

const declareWorker = () => {
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

// The graph that `$worker` declared before `WorkerScript` took `Secrets`:
// one `WorkerSecret` for each secret. The placeholder is left out, as its
// name would differ from the script's. Each secret takes the script's name
// from the script's output.
const declareLegacyWorker = () => {
  workerSecret({ id: "api-key", source: vault, key: "API_KEY" });
  workerSecret({ id: "admin" });
  const code = new std.fs.File("worker:api:code", {
    config: { filePath: "dist/runtime/api/index.mjs" },
  });
  const script = new cloudflare.workers.WorkerScript("worker:api", {
    config: {
      CompatibilityDate: compatibilityDate,
      CompatibilityFlags: ["nodejs_compat"],
      Bindings: [],
      DurableObjectNamespaces: [],
      BoundDurableObjects: [],
    },
    dependencies: { code },
  });
  for (const [name, valueFrom] of [
    [
      "API_KEY",
      { Secret: "api-key", Source: "vault", Key: "API_KEY", Version: "1" },
    ],
    ["ADMIN", { Secret: "admin", Source: "prompt" }],
  ] as const) {
    new cloudflare.workers.WorkerSecret(`worker:api:secret:${name}`, {
      config: { Name: name, ValueFrom: valueFrom },
      dependencies: { placeholder: script as any },
    });
  }
};

let infra: () => void;

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

async function decisions() {
  const planned = await runWithSecretContext(
    { stage: "dev", runId: "plan" },
    async () => {
      const { resources } = await collect();
      return createPlan({ resources, state: runtime.state, registry });
    },
  );
  return Object.fromEntries(
    planned.nodes.map((node) => [node.id, node.decision]),
  );
}

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
  deployments = new Map();
  log = [];
  events = [];
  bindings = "both";
  workerId = "api";
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
  it("uploads the code with its secrets in one request, and records where each value comes from", async () => {
    await deploy("first", prompt);

    const name = onlyWorker();
    expect(name).toMatch(/^shop--dev--api-[0-9a-f]{8}$/);
    expect(log).toEqual([`upload ${name} with ADMIN,API_KEY`]);
    expect(workers.get(name)!.secrets).toEqual(
      new Map([
        ["API_KEY", "sk_live"],
        ["ADMIN", "typed"],
      ]),
    );
    const record = await runtime.state.get("worker:api");
    expect(record?.params.Secrets).toEqual({
      ADMIN: { Secret: "admin", Source: "prompt" },
      API_KEY: {
        Secret: "api-key",
        Source: "vault",
        Key: "API_KEY",
        Version: expect.any(String),
      },
    });
    const values = await runtime.state.values();
    expect(JSON.stringify(values)).not.toMatch(/sk_live|typed/);
    expect(values.map((node) => node.type)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/WorkerSecret|WorkerScriptPlaceholder/),
      ]),
    );

    expect((await decisions())["worker:api"]).toBe("noop");
  });

  it("keeps the name of a live Worker that gains its first secret", async () => {
    bindings = "none";
    await deploy("first");
    const name = onlyWorker();
    log = [];

    bindings = "sourced";
    expect((await decisions())["worker:api"]).toBe("update");
    await deploy("second");

    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`upload ${name} with API_KEY`]);
  });

  it("sends a secret without a source only when the Worker doesn't have it", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    const asked = vi.fn(prompt);
    await deploy("second", asked);

    expect(asked).not.toHaveBeenCalled();
    expect(log).toEqual([`upload ${name} with API_KEY`]);
    expect(workers.get(name)!.secrets.get("ADMIN")).toBe("typed");
  });

  it("keeps a value set with notation secret set", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    await runWithSecretContext({ stage: "dev", runId: "set" }, async () => {
      await collect();
      await secretContext()!.declared.get("admin")!.set!("rotated");
    });

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await deploy("second");

    expect(workers.get(name)!.secrets.get("ADMIN")).toBe("rotated");
  });

  it("deletes a removed secret after the upload, and keeps the name when the last secret goes", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];

    bindings = "sourced";
    await deploy("second");
    expect(log).toEqual([
      `upload ${name} with API_KEY`,
      `delete secret ADMIN on ${name}`,
    ]);

    log = [];
    bindings = "none";
    await deploy("third");
    expect(onlyWorker()).toBe(name);
    expect(log).toEqual([`upload ${name}`, `delete secret API_KEY on ${name}`]);
    expect(workers.get(name)!.secrets.size).toBe(0);
  });

  it("gives a Worker whose id changes a new name with its secrets, and sweeps the old one", async () => {
    await deploy("first", prompt);
    const before = onlyWorker();
    log = [];

    workerId = "web";
    await deploy("second", prompt);

    const after = onlyWorker();
    expect(after).toMatch(/^shop--dev--web-[0-9a-f]{8}$/);
    expect(log).toEqual([
      `upload ${after} with ADMIN,API_KEY`,
      `delete ${before}`,
    ]);
  });

  it("creates no Worker when a secret without a source has no value", async () => {
    bindings = "prompted";
    await expect(deploy("first")).rejects.toThrow(
      "Secret `admin` isn't set for stage dev",
    );

    expect(workers.size).toBe(0);
    expect(log).toEqual([]);
    expect(await runtime.state.get("worker:api")).toBeUndefined();
  });

  it("destroys the Worker with its secrets in one delete", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];

    await destroy("destroy");

    expect(workers.size).toBe(0);
    expect(log).toEqual([`delete ${name}`]);
  });
});

describe("a gradual rollout", () => {
  it("fails a deploy that would upload the Worker during a rollout, and uploads nothing", async () => {
    await deploy("first", prompt);
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
    await deploy("first", prompt);
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

    bindings = "sourced";
    await expect(deploy("second")).rejects.toThrow("is in a gradual rollout");
    expect(log).toEqual([]);
  });

  it("uploads when the newest deployment has one version", async () => {
    await deploy("first", prompt);
    const name = onlyWorker();
    log = [];
    // Listed oldest first, so deploy has to sort them.
    deployments.set(name, [
      {
        created_on: "2026-11-01T00:00:00Z",
        versions: [
          { version_id: "3c9e", percentage: 50 },
          { version_id: "81fa", percentage: 50 },
        ],
      },
      {
        created_on: "2026-11-02T00:00:00Z",
        versions: [{ version_id: "81fa", percentage: 100 }],
      },
    ]);

    await writeBundle("export default { fetch: () => new Response('v2') };\n");
    await deploy("second");
    expect(log).toEqual([`upload ${name} with API_KEY`]);
  });
});

describe("a deployment made with WorkerSecret", () => {
  it("moves the secrets to the script's Secrets, and deletes the WorkerSecret records without the secrets", async () => {
    infra = declareLegacyWorker;
    await deploy("first", prompt);
    const name = onlyWorker();
    expect(workers.get(name)!.secrets).toEqual(
      new Map([
        ["API_KEY", "sk_live"],
        ["ADMIN", "typed"],
      ]),
    );
    log = [];

    infra = declareWorker;
    expect(await decisions()).toMatchObject({
      "worker:api": "update",
      "worker:api:secret:API_KEY": "delete-orphan",
      "worker:api:secret:ADMIN": "delete-orphan",
    });
    const asked = vi.fn(prompt);
    await deploy("second", asked);

    expect(onlyWorker()).toBe(name);
    expect(asked).not.toHaveBeenCalled();
    expect(log).toEqual([`upload ${name} with API_KEY`]);
    expect(workers.get(name)!.secrets).toEqual(
      new Map([
        ["API_KEY", "sk_live"],
        ["ADMIN", "typed"],
      ]),
    );
    expect(await runtime.state.get("worker:api:secret:ADMIN")).toBeUndefined();
    expect(
      await runtime.state.get("worker:api:secret:API_KEY"),
    ).toBeUndefined();
  });
});
