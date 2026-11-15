import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceNotFoundError } from "@notation/resource";
import { WorkerScriptPlaceholder } from "src/resources/workers/worker-script-placeholder";
import { calls, fail, mockFetch, ok } from "../../mock-api";

const params = { AccountId: "acc", ScriptName: "app--dev--api" };

const placeholder = new WorkerScriptPlaceholder("worker:api:placeholder", {
  config: params,
});

const tagged = { tags: ["notation-placeholder"] };

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WorkerScriptPlaceholder", () => {
  it("refuses a create, and calls nothing", async () => {
    mockFetch(() => ok({}));

    await expect(placeholder.create(params)).rejects.toThrow("deprecated");
    expect(calls).toEqual([]);
  });

  it("reads a missing Worker as not found", async () => {
    mockFetch(() => fail(404, 10007, "not found"));

    await expect(
      placeholder.read!(params, undefined, {} as any),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("reads a Worker that exists", async () => {
    mockFetch(() => ok({}));

    await expect(
      placeholder.read!(params, undefined, {} as any),
    ).resolves.toEqual(params);
  });

  it("deletes the Worker only while it carries the tag", async () => {
    mockFetch(() => ok(tagged));
    await placeholder.delete!(params, params as any);
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);

    for (const respond of [() => ok({}), () => fail(404, 10007)]) {
      calls.length = 0;
      vi.restoreAllMocks();
      mockFetch(respond);
      await placeholder.delete!(params, params as any);
      expect(calls.map((call) => call.method)).toEqual(["GET"]);
    }
  });
});
