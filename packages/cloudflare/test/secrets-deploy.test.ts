import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeDurableRuntime,
  Redacted,
  runDurableWorkflow,
  runWithSecretContext,
  secretContext,
  type SecretPrompt,
  type Source,
} from "@notation/core";
import { createPlan, type ReconcilerEvent } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import { collectResourceGraph } from "@notation/resource";
import { secret } from "src/secrets-store";

const SENTINEL = "sentinel-7c1e5d0a-value";
const PROMPTED = "prompted-93b2f4e1-value";

let directory: string;
let runtime: NodeDurableRuntime;
let events: ReconcilerEvent[];
let secrets: Map<string, { id: string; value: string }>;
// Set to make Cloudflare echo the value back in an error, as an API can.
let rejectWrites: boolean;

const fail = (message: string) =>
  Response.json(
    { success: false, errors: [{ code: 1001, message }], result: null },
    { status: 400 },
  );
const ok = (result: unknown) =>
  Response.json({ success: true, errors: [], result });

// The Secrets Store API of one account with one store.
function fakeCloudflare() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const route = url.pathname.replace(
      "/client/v4/accounts/acc/secrets_store/stores",
      "",
    );
    if (route === "" && method === "GET") return ok([{ id: "st", name: "s" }]);
    if (route === "/st" && method === "GET") return ok({ id: "st", name: "s" });
    if (route === "/st/secrets" && method === "GET") {
      return ok(
        [...secrets.entries()].map(([name, { id }]) => ({
          id,
          name,
          status: "active",
        })),
      );
    }
    if (route === "/st/secrets" && method === "POST") {
      const [{ name, value }] = body;
      if (rejectWrites) return fail(`invalid secret value ${value}`);
      secrets.set(name, { id: `id-${name}`, value });
      return ok([{ id: `id-${name}`, name, status: "active" }]);
    }
    const patch = route.match(/^\/st\/secrets\/id-(.+)$/);
    if (patch && method === "PATCH") {
      if (rejectWrites) {
        return fail(`invalid secret value ${JSON.stringify(body.value)}`);
      }
      secrets.set(patch[1]!, { id: `id-${patch[1]}`, value: body.value });
      return ok({ id: `id-${patch[1]}` });
    }
    return fail(`unexpected ${method} ${url.pathname}`);
  });
}

// A source with no versions, like `env`, whose value is the sentinel.
const vault: Source = {
  name: "vault",
  has: async () => true,
  get: async () => new Redacted(SENTINEL),
};

const infra = () => {
  secret({ id: "stripe-key", source: vault, key: "STRIPE_KEY" });
  secret({ id: "admin" });
};

const collect = () =>
  collectResourceGraph(infra, { scope: { app: "shop", stage: "dev" } });

// Runs a deploy as `deployApp` does, in a secret context.
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
            state: runtime.state,
            emit: (event) => {
              events.push(event);
            },
          }),
      );
    },
  );
}

function plan() {
  return runWithSecretContext({ stage: "dev", runId: "plan" }, async () => {
    const { resources } = await collect();
    return createPlan({ resources, state: runtime.state });
  });
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-secrets-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "shop", stage: "dev" },
    databasePath: path.join(directory, "workflows.db"),
  });
  events = [];
  secrets = new Map();
  rejectWrites = false;
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  fakeCloudflare();
});

afterEach(async () => {
  runtime.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("secrets in a deploy", () => {
  it("writes a sourced secret on every deploy, and asks for a secret without a source once", async () => {
    const prompt = vi.fn(async () => PROMPTED);

    await deploy("first", prompt);

    expect(secrets.get("shop--dev--stripe-key")?.value).toBe(SENTINEL);
    expect(secrets.get("shop--dev--admin")?.value).toBe(PROMPTED);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect((await runtime.state.get("secret:stripe-key"))?.params).toEqual({
      AccountId: "acc",
      StoreId: "st",
      Name: "shop--dev--stripe-key",
      StageScoped: true,
      ValueFrom: {
        Secret: "stripe-key",
        Source: "vault",
        Key: "STRIPE_KEY",
        Version: "first",
      },
    });

    const planned = await plan();
    const decisions = Object.fromEntries(
      planned.nodes.map((node) => [node.id, node.decision]),
    );
    expect(decisions).toMatchObject({
      "value:stripe-key": "update",
      "secret:admin": "noop",
    });

    secrets.get("shop--dev--stripe-key")!.value = "changed by hand";
    await deploy("second", prompt);

    expect(secrets.get("shop--dev--stripe-key")?.value).toBe(SENTINEL);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("creates a missing secret without a source again when it is deleted outside notation", async () => {
    const prompt = vi.fn(async () => PROMPTED);
    await deploy("first", prompt);

    secrets.delete("shop--dev--admin");
    await deploy("second", prompt);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(secrets.get("shop--dev--admin")?.value).toBe(PROMPTED);
  });

  it("fails without a prompt for a secret without a source that is missing", async () => {
    await expect(deploy("first")).rejects.toThrow(
      "Secret `admin` isn't set for stage dev. Run `notation secret set admin --stage dev`.",
    );
  });

  it("keeps a secret without a source that notation secret set wrote before the first deploy", async () => {
    await runWithSecretContext({ stage: "dev", runId: "set" }, async () => {
      await collect();
      await secretContext()!.declared.get("admin")!.set!(PROMPTED);
    });

    await deploy("first");

    expect(secrets.get("shop--dev--admin")?.value).toBe(PROMPTED);
  });

  it("fails at plan when the source doesn't have the key", async () => {
    const empty: Source = { ...vault, has: async () => false };
    await expect(
      runWithSecretContext({ stage: "dev", runId: "plan" }, async () => {
        const { resources } = await collectResourceGraph(
          () => secret({ id: "stripe-key", source: empty, key: "STRIPE_KEY" }),
          { scope: { app: "shop", stage: "dev" } },
        );
        return createPlan({ resources, state: runtime.state });
      }),
    ).rejects.toThrow(
      "`STRIPE_KEY` isn't in the vault source of `stripe-key`.",
    );
  });
});

// Rule 1 of RFC 0017: notation never records a secret's value.
describe("the sentinel", () => {
  async function recordedFiles(): Promise<Buffer> {
    const files = await readdir(directory);
    return Buffer.concat(
      await Promise.all(
        files.map((file) => readFile(path.join(directory, file))),
      ),
    );
  }

  it("is in no state record, journal, plan, event or error, even when Cloudflare echoes it", async () => {
    const prompt = vi.fn(async () => PROMPTED);
    await deploy("first", prompt);
    const planned = await plan();
    rejectWrites = true;
    const error = await deploy("second", prompt).catch((e: Error) => e);

    // Cloudflare received the value, and echoed it in its error.
    expect(secrets.get("shop--dev--stripe-key")?.value).toBe(SENTINEL);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid secret value");

    const forms = (value: string) => [
      value,
      Buffer.from(value).toString("base64"),
    ];
    const recorded = {
      state: JSON.stringify(await runtime.state.values()),
      plan: JSON.stringify(planned),
      events: JSON.stringify(events),
      error: `${(error as Error).message}\n${(error as Error).stack}`,
    };
    const files = await recordedFiles();
    for (const value of [...forms(SENTINEL), ...forms(PROMPTED)]) {
      for (const [where, text] of Object.entries(recorded)) {
        expect(text, `${where} holds a secret value`).not.toContain(value);
      }
      expect(files.includes(value), "the journal holds a secret value").toBe(
        false,
      );
    }
    expect(recorded.error).toContain("<hidden>");
  });
});
