import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceNotFoundError } from "@notation/resource";
import { WorkerSecret } from "src/resources/workers/worker-secret";
import { calls, fail, mockFetch, ok } from "../../mock-api";

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

const resource = new WorkerSecret("worker:api:secret:API_KEY", {
  config: sourced,
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
  it("refuses a create, and calls nothing", async () => {
    mockFetch(() => ok({}));

    await expect(resource.create(sourced)).rejects.toThrow("deprecated");
    expect(calls).toEqual([]);
  });

  it("reads a missing secret, or a binding of another type, as not found", async () => {
    mockFetch(withBinding());
    await expect(
      resource.read!(key, undefined, {} as any),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    vi.restoreAllMocks();
    mockFetch(withBinding({ type: "plain_text" }));
    await expect(
      resource.read!(key, undefined, {} as any),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    vi.restoreAllMocks();
    mockFetch(() => fail(404, 10007, "This Worker does not exist"));
    await expect(
      resource.read!(key, undefined, {} as any),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reads a secret that the Worker has", async () => {
    mockFetch(withBinding({ type: "secret_text" }));

    await expect(resource.read!(key, undefined, {} as any)).resolves.toEqual(
      key,
    );
  });

  // The upload of the Worker has set the same secret through `Secrets`.
  it("deletes only the record, and leaves the secret on the Worker", async () => {
    mockFetch(() => ok(null));

    await resource.delete!(key, sourced as any);

    expect(calls).toEqual([]);
  });
});
