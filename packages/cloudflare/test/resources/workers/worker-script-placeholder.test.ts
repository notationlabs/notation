import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceAlreadyExistsError,
  ResourceNotFoundError,
} from "@notation/resource";
import { WorkerScriptPlaceholder } from "src/resources/workers/worker-script-placeholder";
import { calls, fail, mockFetch, ok, type Call } from "../../mock-api";

const scriptUrl =
  "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api";

const params = { AccountId: "acc", ScriptName: "app--dev--api" };

const placeholder = new WorkerScriptPlaceholder("worker:api:placeholder");

const tagged = { tags: ["notation-placeholder"] };

// Answers a read of the Worker's settings as not found until the first
// upload, and every other call with ok.
function untilUploaded() {
  let uploaded = false;
  return (call: Call) => {
    if (call.method === "PUT") uploaded = true;
    if (call.method === "GET") {
      return uploaded ? ok(tagged) : fail(404, 10007, "not found");
    }
    return ok({});
  };
}

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WorkerScriptPlaceholder", () => {
  it("uploads a tagged Worker that answers 503 when no Worker exists", async () => {
    mockFetch(untilUploaded());

    await placeholder.create(params);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${scriptUrl}/settings`],
      ["PUT", scriptUrl],
      ["GET", `${scriptUrl}/settings`],
    ]);
    const form = calls[1]!.body as FormData;
    const metadata = JSON.parse(form.get("metadata") as string);
    expect(metadata).toMatchObject({
      main_module: "placeholder.mjs",
      tags: ["notation-placeholder"],
      bindings: [],
    });
    const module = await (form.get("placeholder.mjs") as File).text();
    expect(module).toContain("status: 503");
  });

  it("does nothing when a retried create finds its tagged Worker", async () => {
    mockFetch(() => ok(tagged));

    await placeholder.create(params);

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("does nothing for the live Worker of the script's record", async () => {
    mockFetch(() => ok({ compatibility_date: "2026-10-12" }));

    await placeholder.create({
      ...params,
      AdoptedScriptName: "app--dev--api",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("refuses a Worker that exists without the tag, and never uploads over it", async () => {
    for (const settings of [{}, { tags: ["other"] }, { tags: null }]) {
      calls.length = 0;
      vi.restoreAllMocks();
      mockFetch(() => ok(settings));

      const created = placeholder.create({
        ...params,
        AdoptedScriptName: "app--dev--other",
      });

      await expect(created).rejects.toThrow(
        "A Worker named app--dev--api already exists in the Cloudflare account acc",
      );
      // Deploy would take over a Worker reported as already existing.
      await expect(created).rejects.not.toSatisfy(
        ResourceAlreadyExistsError.is,
      );
      expect(calls.map((call) => call.method)).toEqual(["GET"]);
    }
  });

  it("uploads a placeholder when the Worker of the script's record is gone", async () => {
    mockFetch(untilUploaded());

    await placeholder.create({
      ...params,
      AdoptedScriptName: "app--dev--api",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("reads a missing Worker as not found", async () => {
    mockFetch(() => fail(404, 10007, "not found"));

    await expect(placeholder.read!(params)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("reads a Worker that exists", async () => {
    mockFetch(() => ok({}));

    await expect(placeholder.read!(params)).resolves.toEqual(params);
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

  it("names itself after the Worker, as the script does", () => {
    const rule = (placeholder as any).schema.ScriptName.physicalName;

    expect(rule.base("worker:api:placeholder")).toBe("api");
    expect(rule.suppliable).toBe(true);
  });
});
