import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_SOURCE,
  runWithSecretContext,
  secretContext,
  setConfigFile,
} from "@notation/core";
import {
  collectResourceGraph,
  declaredIn,
  type ResourceGraph,
} from "@notation/resource";
import { env } from "@notation/std/sources";
import {
  $worker,
  isWorkerGroup,
  workerSecret,
  type WorkerGroup,
} from "src/workers";

const compatibilityDate = "2026-10-12";
const scripts = "/client/v4/accounts/acc/workers/scripts";

beforeEach(() => setConfigFile("/some/project/notation.config.ts"));
afterEach(() => {
  setConfigFile(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const inWorker = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "worker", { exports: [], starExports: [] });

const worker = (graph: ResourceGraph, id: string): WorkerGroup =>
  graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  ) as WorkerGroup;

// Two Workers that bind the same secret without a source, under two names.
const infra = () => {
  const admin = workerSecret({ id: "admin" });
  inWorker(
    $worker({
      id: "api",
      compatibilityDate,
      bindings: () => ({ ADMIN: admin }),
    }),
    "runtime/api.ts",
  );
  inWorker(
    $worker({
      id: "jobs",
      compatibilityDate,
      bindings: () => ({ ADMIN_PASSWORD: admin }),
    }),
    "runtime/jobs.ts",
  );
};

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

describe("workerSecret", () => {
  it("adds a WorkerSecret to the Worker for each binding, after its script", async () => {
    const graph = await collect(infra);
    const api = worker(graph, "api");
    const jobs = worker(graph, "jobs");

    expect(api.script.config.Bindings).toEqual([]);
    expect(api.secrets.map((secret) => secret.id)).toEqual([
      "worker:api:secret:ADMIN",
    ]);
    expect(api.secrets[0]!.getDependencies()).toContain(api.script);
    expect(api.secrets[0]!.config).toEqual({
      Name: "ADMIN",
      ValueFrom: { Secret: "admin", Source: PROMPT_SOURCE },
    });
    expect(jobs.secrets[0]!.config.Name).toBe("ADMIN_PASSWORD");
  });

  it("takes the version of a sourced secret from its SourceValue", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
    let apiKey!: ReturnType<typeof workerSecret>;
    const graph = await collect(() => {
      apiKey = workerSecret({ id: "api-key", source: env, key: "API_KEY" });
      inWorker(
        $worker({
          id: "api",
          compatibilityDate,
          bindings: () => ({ API_KEY: apiKey }),
        }),
        "runtime/api.ts",
      );
    });
    const [secret] = worker(graph, "api").secrets;

    expect(secret!.getDependencies()).toContain(apiKey.value);
    apiKey.value!.setOutput({ Version: "run-1" } as any);
    worker(graph, "api").script.setOutput({
      AccountId: "acc",
      ScriptName: "shop--dev--api-1a2b3c4d",
    } as any);
    expect(await secret!.getParams()).toEqual({
      AccountId: "acc",
      ScriptName: "shop--dev--api-1a2b3c4d",
      Name: "API_KEY",
      ValueFrom: {
        Secret: "api-key",
        Source: "env",
        Key: "API_KEY",
        Version: "run-1",
      },
    });
  });

  it("has no SourceValue without a source", async () => {
    await collect(() => {
      expect(workerSecret({ id: "admin" }).value).toBeUndefined();
    });
  });

  it("rejects a source without a key", async () => {
    await collect(() => {
      expect(() => workerSecret({ id: "api-key", source: env } as any)).toThrow(
        'workerSecret({ id: "api-key" }) has a source but no key',
      );
    });
  });

  describe("set and delete", () => {
    let calls: { method: string; path: string; body: unknown }[];
    let deployed: string[];

    beforeEach(() => {
      calls = [];
      deployed = [];
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const call = {
          method: init?.method ?? "GET",
          path: new URL(String(url)).pathname,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        };
        calls.push(call);
        const result =
          call.method === "GET" ? deployed.map((id) => ({ id })) : null;
        return Response.json({ success: true, errors: [], result });
      });
    });

    // Collects the infra as `notation secret set` does, and returns the
    // declared secret.
    const declared = () =>
      runWithSecretContext({ stage: "dev", runId: "set" }, async () => {
        await collect(infra);
        return secretContext()!.declared.get("admin")!;
      });

    it("writes the value to each Worker that binds the secret, found by name", async () => {
      deployed = [
        "shop--dev--api-1a2b3c4d",
        "shop--dev--jobs-0f0f0f0f",
        "shop--prod--api-1a2b3c4d",
        "other",
      ];

      await (
        await declared()
      ).set!("hunter2");

      expect(calls.filter((call) => call.method === "PUT")).toEqual([
        {
          method: "PUT",
          path: `${scripts}/shop--dev--api-1a2b3c4d/secrets`,
          body: { name: "ADMIN", text: "hunter2", type: "secret_text" },
        },
        {
          method: "PUT",
          path: `${scripts}/shop--dev--jobs-0f0f0f0f/secrets`,
          body: {
            name: "ADMIN_PASSWORD",
            text: "hunter2",
            type: "secret_text",
          },
        },
      ]);
    });

    it("writes to the deployed Workers when another Worker that binds it isn't deployed", async () => {
      deployed = ["shop--dev--api-1a2b3c4d"];

      await (
        await declared()
      ).set!("hunter2");

      expect(
        calls.filter((call) => call.method === "PUT").map((call) => call.path),
      ).toEqual([`${scripts}/shop--dev--api-1a2b3c4d/secrets`]);
    });

    it("says to deploy when no Worker that binds it is deployed", async () => {
      deployed = ["other"];

      await expect((await declared()).set!("hunter2")).rejects.toThrow(
        "No deployed Worker binds the Worker secret `admin`. Run `notation deploy` first.",
      );
    });

    it("refuses, and writes nothing, when two Workers match one that binds it", async () => {
      deployed = [
        "shop--dev--api-1a2b3c4d",
        "shop--dev--api-99999999",
        "shop--dev--jobs-0f0f0f0f",
      ];

      await expect((await declared()).set!("hunter2")).rejects.toThrow(
        "More than one Worker matches the Worker that binds `admin` as ADMIN: shop--dev--api-1a2b3c4d, shop--dev--api-99999999.",
      );
      expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
    });

    it("deletes nothing, and succeeds, when no Worker that binds it is deployed", async () => {
      deployed = ["other"];

      await (
        await declared()
      ).delete!();

      expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
    });

    it("deletes the secret from each Worker that binds it", async () => {
      deployed = ["shop--dev--api-1a2b3c4d", "shop--dev--jobs-0f0f0f0f"];

      await (
        await declared()
      ).delete!();

      expect(
        calls
          .filter((call) => call.method === "DELETE")
          .map((call) => call.path),
      ).toEqual([
        `${scripts}/shop--dev--api-1a2b3c4d/secrets/ADMIN`,
        `${scripts}/shop--dev--jobs-0f0f0f0f/secrets/ADMIN_PASSWORD`,
      ]);
    });

    it("fails when no Worker binds the secret", async () => {
      const secret = await runWithSecretContext(
        { stage: "dev", runId: "set" },
        async () => {
          await collect(() => workerSecret({ id: "admin" }));
          return secretContext()!.declared.get("admin")!;
        },
      );

      await expect(secret.set!("hunter2")).rejects.toThrow(
        "No deployed Worker binds the Worker secret `admin`",
      );
    });
  });
});
