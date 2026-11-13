import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceNotFoundError } from "@notation/resource";
import { CloudflareApiError } from "src/api/client";
import { WorkerSubdomain } from "src/resources/workers/worker-subdomain";
import { calls, fail, mockFetch, ok } from "../../mock-api";

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("WorkerSubdomain", () => {
  const subdomain = new WorkerSubdomain("worker:api:subdomain", {
    dependencies: {} as any,
  });
  const key = { AccountId: "acc", ScriptName: "app--dev--api" };

  it("enables workers.dev and reads the URL from the account's subdomain", async () => {
    mockFetch((call) =>
      call.url.endsWith("/workers/subdomain")
        ? ok({ subdomain: "team" })
        : ok({ enabled: true, previews_enabled: false }),
    );

    await subdomain.create(key);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ enabled: true });
    await expect(subdomain.read!(key)).resolves.toEqual({
      ...key,
      Url: "https://app--dev--api.team.workers.dev",
    });
  });

  it("turns preview URLs off for a fixed name longer than 54 characters", async () => {
    mockFetch(() => ok({ enabled: true, previews_enabled: false }));
    const ScriptName = "app--dev--".padEnd(63, "a");

    await subdomain.create({ AccountId: "acc", ScriptName });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      enabled: true,
      previews_enabled: false,
    });
  });

  it("explains that the account has no workers.dev subdomain", async () => {
    mockFetch((call) =>
      call.url.endsWith("/workers/subdomain")
        ? fail(404, 10007, "not found")
        : ok({ enabled: true, previews_enabled: false }),
    );

    const error = await subdomain.read!(key).catch((error) => error);
    expect(error.message).toContain(
      "The account acc has no workers.dev subdomain.",
    );
    expect(error.cause).toBeInstanceOf(CloudflareApiError);
  });

  it("fails with the API error for a 404 that Cloudflare can't route", async () => {
    mockFetch((call) =>
      call.url.endsWith("/workers/subdomain")
        ? fail(404, 7003, "Could not route")
        : ok({ enabled: true, previews_enabled: false }),
    );

    await expect(subdomain.read!(key)).rejects.toThrow(
      "failed with status 404",
    );
  });

  it("reads a Worker that is not on workers.dev as not found", async () => {
    mockFetch(() => ok({ enabled: false, previews_enabled: false }));

    await expect(subdomain.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});
