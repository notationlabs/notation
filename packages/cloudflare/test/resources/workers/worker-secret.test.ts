import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declareSecret,
  PROMPT_SOURCE,
  Redacted,
  runWithSecretContext,
  type SecretPrompt,
  type Source,
} from "@notation/core";
import {
  collectResourceGraph,
  ResourceNotFoundError,
} from "@notation/resource";
import { decideAction } from "@notation/reconciler";
import { WorkerSecret } from "src/resources/workers/worker-secret";
import { calls, fail, mockFetch, ok } from "../../mock-api";

const secretUrl =
  "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api/secrets";

const key = { AccountId: "acc", ScriptName: "app--dev--api", Name: "API_KEY" };
const sourced = {
  ...key,
  ValueFrom: {
    Secret: "api-key",
    Source: "vault",
    Key: "API_KEY",
    Version: "7",
  },
};
const prompted = {
  ...key,
  ValueFrom: { Secret: "api-key", Source: PROMPT_SOURCE },
};

const resource = new WorkerSecret("worker:api:secret:API_KEY", {
  config: { Name: "API_KEY", ValueFrom: sourced.ValueFrom },
  dependencies: {} as any,
});

const vault: Source = {
  name: "vault",
  has: async () => true,
  get: async () => new Redacted("sk_from_vault"),
};

// Runs `fn` as deploy does, with the secret declared.
const deploying = <T>(
  fn: () => Promise<T>,
  { source, prompt }: { source?: Source; prompt?: SecretPrompt } = {},
) =>
  runWithSecretContext({ stage: "dev", runId: "run", prompt }, async () => {
    await collectResourceGraph(() =>
      declareSecret({
        id: "api-key",
        source,
        key: source ? "API_KEY" : undefined,
      }),
    );
    return fn();
  });

// Answers a read of the secret with `binding`, and every other call with ok.
const withBinding = (binding?: { type: string }) => () =>
  binding ? ok({ name: "API_KEY", ...binding }) : fail(404, 10056);

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WorkerSecret", () => {
  it("writes the value from the source at create", async () => {
    mockFetch(() => ok({ name: "API_KEY", type: "secret_text" }));

    await deploying(() => resource.create(sourced), { source: vault });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["PUT", secretUrl],
      ["GET", `${secretUrl}/API_KEY`],
    ]);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      name: "API_KEY",
      text: "sk_from_vault",
      type: "secret_text",
    });
  });

  it("waits after a write until Cloudflare reports the secret", async () => {
    let reads = 0;
    mockFetch((call) =>
      call.method === "GET" && ++reads < 3
        ? fail(404, 10056)
        : ok({ name: "API_KEY", type: "secret_text" }),
    );

    await deploying(() => resource.create(sourced), { source: vault });

    expect(calls.map((call) => call.method)).toEqual([
      "PUT",
      "GET",
      "GET",
      "GET",
    ]);
  });

  it("asks for a secret without a source that the Worker doesn't have", async () => {
    let written = false;
    mockFetch((call) => {
      if (call.method === "PUT") written = true;
      return call.method === "GET" && !written
        ? fail(404, 10056)
        : ok({ type: "secret_text" });
    });
    const prompt = vi.fn(async () => "typed");

    await deploying(() => resource.create(prompted), { prompt });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(JSON.parse(calls[1]!.body as string).text).toBe("typed");
  });

  it("keeps a secret without a source that the Worker has, without asking", async () => {
    mockFetch(withBinding({ type: "secret_text" }));
    const prompt = vi.fn(async () => "typed");

    await deploying(() => resource.create(prompted), { prompt });

    expect(prompt).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("writes at update only when ValueFrom changes", async () => {
    mockFetch(() => ok({ type: "secret_text" }));

    await deploying(
      async () => {
        await resource.update!(key, {} as any, sourced, sourced);
        expect(calls).toEqual([]);
        await resource.update!(
          key,
          { ValueFrom: sourced.ValueFrom } as any,
          sourced,
          sourced,
        );
      },
      { source: vault },
    );

    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
  });

  it("updates when the source's version changes", () => {
    const action = decideAction({
      resource,
      stateNode: { params: sourced } as any,
      params: {
        ...sourced,
        ValueFrom: { ...sourced.ValueFrom, Version: "8" },
      },
    });

    expect(action).toMatchObject({ decision: "update" });
  });

  it("reads a missing secret, or a binding of another type, as not found", async () => {
    mockFetch(withBinding());
    await expect(resource.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );

    vi.restoreAllMocks();
    mockFetch(withBinding({ type: "plain_text" }));
    await expect(resource.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );

    vi.restoreAllMocks();
    mockFetch(() => fail(404, 10007, "This Worker does not exist"));
    await expect(resource.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("reads a secret that the Worker has", async () => {
    mockFetch(withBinding({ type: "secret_text" }));

    await expect(resource.read!(key)).resolves.toEqual(key);
  });

  it("deletes the secret, and succeeds when it or the Worker is gone", async () => {
    mockFetch(() => ok(null));
    await resource.delete!(key, sourced as any);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["DELETE", `${secretUrl}/API_KEY`],
    ]);

    for (const code of [10056, 10007]) {
      vi.restoreAllMocks();
      mockFetch(() => fail(404, code));
      await expect(
        resource.delete!(key, sourced as any),
      ).resolves.toBeUndefined();
    }
  });
});
