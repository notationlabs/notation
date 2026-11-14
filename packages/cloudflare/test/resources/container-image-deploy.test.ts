import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  runDurableWorkflow,
  setConfigFile,
} from "@notation/core";
import { createPlan } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph } from "@notation/resource";
import { fs } from "@notation/std/resources";
import { containers, workers } from "src/resources";
import { runDocker } from "src/resources/containers/docker";

vi.mock("src/resources/containers/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/resources/containers/docker")>()),
  runDocker: vi.fn(),
}));

const docker = vi.mocked(runDocker);

let root: string;
let runtime: NodeDurableRuntime;
// The digest that the fake registry has for each tag that was pushed.
let pushed: Map<string, string>;
let application: { configuration: { image: string } } | undefined;
let rollouts: { image: string }[];
// The name of the Worker that was uploaded.
let scriptName: string | undefined;

const ok = (result: unknown = null) =>
  Response.json({ success: true, errors: [], result });

const fail = (status: number, code: number, message: string) =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

// The Workers, Durable Objects and Containers APIs of one account, and its
// registry. A push gives the tag a digest made from the tag.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.hostname === "registry.cloudflare.com") {
      const tag = url.pathname.match(/^\/v2\/ext1\/sandbox\/manifests\/(.+)$/);
      const digest = tag && pushed.get(tag[1]!);
      return digest
        ? new Response(null, { headers: { "Docker-Content-Digest": digest } })
        : new Response(null, { status: 404 });
    }
    const route = url.pathname.replace("/client/v4/accounts/acc", "");
    if (route === "/containers/me") return ok({ external_account_id: "ext1" });
    if (route.endsWith("/credentials")) {
      return ok({ username: "user", password: "secret" });
    }
    if (route.match(/^\/workers\/scripts\/[^/]+\/settings$/)) {
      return scriptName
        ? ok({ compatibility_date: "2026-10-12" })
        : fail(404, 10007, "This Worker does not exist on your account.");
    }
    const upload = route.match(/^\/workers\/scripts\/([^/]+)$/);
    if (upload && method === "PUT") {
      scriptName = upload[1];
      return ok({});
    }
    if (route === "/workers/durable_objects/namespaces") {
      const first = url.searchParams.get("page") === "1";
      return ok(
        scriptName && first
          ? [{ id: "ns1", class: "Sandbox", script: scriptName }]
          : [],
      );
    }
    if (route === "/containers/applications" && method === "POST") {
      application = { configuration: body.configuration };
      return ok({ id: "app1", name: body.name });
    }
    if (route === "/containers/applications" && method === "GET") {
      return ok(application ? [applicationResult()] : []);
    }
    if (route === "/containers/applications/app1" && method === "GET") {
      return ok(applicationResult());
    }
    if (route === "/containers/applications/app1/rollouts") {
      rollouts.push({ image: body.target_configuration.image });
      application!.configuration = body.target_configuration;
      return ok({});
    }
    return fail(400, 1000, `unexpected ${method} ${url.pathname}`);
  });
}

function applicationResult() {
  return {
    id: "app1",
    name: "sandbox",
    max_instances: 1,
    durable_objects: { namespace_id: "ns1" },
  };
}

const infra = () => {
  const code = new fs.File("worker:api:code", {
    config: { filePath: "worker.js" },
  });
  const script = new workers.WorkerScript("worker:api", {
    config: {
      CompatibilityDate: "2026-10-12",
      DurableObjectNamespaces: [
        { id: "sandboxes", className: "Sandbox", container: true },
      ],
    },
    dependencies: { code },
  });
  const image = new containers.ContainerImage("sandbox:image", {
    config: { Repository: "sandbox", Context: "sandbox" },
  });
  new containers.ContainerApplication("sandbox", {
    config: {
      Name: "sandbox",
      HostedNamespaceId: "sandboxes",
      MaxInstances: 1,
      Configuration: { image: image.outputRef("Image") },
    },
    dependencies: { script },
  });
};

const collect = () =>
  collectResourceGraph(infra, { scope: { app: "shop", stage: "dev" } });

async function deploy(executionId: string) {
  const { resources } = await collect();
  await runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, id) =>
      durable.deploy(step, {
        executionId: id,
        resources,
        state: runtime.state,
        nameScope: { app: "shop", stage: "dev" },
      }),
  );
}

async function plan() {
  const { resources } = await collect();
  const planned = await createPlan({ resources, state: runtime.state });
  return Object.fromEntries(
    planned.nodes.map((node) => [node.id, node.decision]),
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "container-image-deploy-"));
  setConfigFile(path.join(root, "notation.config.ts"));
  writeFileSync(path.join(root, "worker.js"), "export default {};\n");
  mkdirSync(path.join(root, "sandbox"));
  writeFileSync(path.join(root, "sandbox/Dockerfile"), "FROM alpine\n");
  writeFileSync(path.join(root, "sandbox/server.js"), "console.log(1)\n");
  runtime = new NodeDurableRuntime({
    deployment: { app: "shop", stage: "dev" },
    databasePath: path.join(root, "workflows.db"),
  });
  pushed = new Map();
  application = undefined;
  rollouts = [];
  scriptName = undefined;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  docker.mockReset();
  docker.mockImplementation(async (args) => {
    if (args[0] === "push") {
      const tag = args[1]!.split(":").at(-1)!;
      pushed.set(tag, `sha256:${tag.padEnd(64, "0")}`);
    }
  });
  fakeCloudflare();
});

afterEach(() => {
  runtime.close();
  setConfigFile(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("ContainerImage in a deploy", () => {
  it("creates the application with the pushed image, and rolls out a new image when the build context changes", async () => {
    await deploy("first");

    const [firstTag] = [...pushed.keys()];
    expect(application?.configuration.image).toBe(
      `registry.cloudflare.com/ext1/sandbox@${pushed.get(firstTag!)}`,
    );
    expect(await plan()).toMatchObject({
      "sandbox:image": "noop",
      sandbox: "noop",
    });

    writeFileSync(path.join(root, "sandbox/server.js"), "console.log(2)\n");
    expect(await plan()).toMatchObject({
      "sandbox:image": "replace",
      sandbox: "update",
    });
    await deploy("second");

    const secondTag = [...pushed.keys()].find((tag) => tag !== firstTag);
    expect(secondTag).toBeDefined();
    expect(rollouts).toEqual([
      {
        image: `registry.cloudflare.com/ext1/sandbox@${pushed.get(secondTag!)}`,
      },
    ]);
    expect(await plan()).toMatchObject({
      "sandbox:image": "noop",
      sandbox: "noop",
    });
  });
});
