import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import {
  durableObjectExports,
  WorkerScript,
} from "src/resources/workers/worker-script";
import { WorkerSubdomain } from "src/resources/workers/worker-subdomain";

let root: string;
const code = "export default { fetch() { return new Response('ok'); } };";
const codeSha256 = crypto.createHash("sha256").update(code).digest("base64");

type Call = { method: string; url: string; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body,
    };
    calls.push(call);
    return respond(call);
  });
}

const ok = (result: unknown = null) =>
  Response.json({ success: true, errors: [], result });

const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

const params = {
  AccountId: "acc",
  ScriptName: "app--dev--api",
  MainModule: "index.mjs",
  CodeFilePath: "dist/runtime/api/index.mjs",
  CodeSha256: codeSha256,
  CompatibilityDate: "2026-10-12",
  CompatibilityFlags: ["nodejs_compat"],
  Bindings: [
    { type: "plain_text" as const, name: "GREETING", text: "hello" },
    {
      type: "durable_object_namespace" as const,
      name: "COUNTERS",
      class_name: "Counter",
    },
  ],
  DurableObjectNamespaces: [{ id: "counters", className: "Counter" }],
};

const script = new WorkerScript("worker:api", {
  config: {
    ScriptName: params.ScriptName,
    CompatibilityDate: params.CompatibilityDate,
  },
  dependencies: {} as any,
});

async function uploadedMetadata(call: Call) {
  const form = call.body as FormData;
  const module = form.get("index.mjs") as File;
  return {
    metadata: JSON.parse(form.get("metadata") as string),
    module: { type: module.type, text: await module.text() },
  };
}

beforeEach(() => {
  calls = [];
  root = mkdtempSync(path.join(os.tmpdir(), "notation-cf-"));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
  const file = path.join(root, params.CodeFilePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, code);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("WorkerScript", () => {
  it("uploads the bundle as an ES module, with its bindings and namespaces", async () => {
    mockFetch((call) =>
      call.method === "GET" ? fail(404, 10007, "not found") : ok({}),
    );

    await script.create(params);

    const put = calls[1]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api",
    );
    expect(await uploadedMetadata(put)).toEqual({
      metadata: {
        main_module: "index.mjs",
        compatibility_date: "2026-10-12",
        compatibility_flags: ["nodejs_compat"],
        bindings: params.Bindings,
        exports: { Counter: { type: "durable-object", storage: "sqlite" } },
      },
      module: { type: "application/javascript+module", text: code },
    });
  });

  it("leaves exports out for a Worker that hosts no namespace", async () => {
    mockFetch((call) => (call.method === "GET" ? fail(404, 10007) : ok({})));

    await script.create({ ...params, DurableObjectNamespaces: [] });

    const { metadata } = await uploadedMetadata(calls[1]!);
    expect(metadata).not.toHaveProperty("exports");
  });

  it("doesn't take over a Worker that exists already", async () => {
    mockFetch(() => ok({ compatibility_date: "2026-01-01" }));

    await expect(script.create(params)).rejects.toThrow(
      "A Worker named app--dev--api already exists in the Cloudflare account acc",
    );
    expect(calls).toHaveLength(1);
  });

  it("fails when the bundle changed after the params were computed", async () => {
    mockFetch(() => fail(404, 10007));

    await expect(
      script.create({ ...params, CodeSha256: "other" }),
    ).rejects.toThrow("The file changed after the deploy computed its params");
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch((call) =>
      call.method === "GET" ? fail(404, 10007) : fail(502, 0, "bad gateway"),
    );

    await expect(script.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("fails, and doesn't report the create as unknown, when the check for an existing Worker fails", async () => {
    mockFetch(() => fail(502, 0, "bad gateway"));

    const error = await script.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain("failed with status 502");
    expect(calls).toHaveLength(1);
  });

  it("reports a create whose upload timed out as unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if ((init?.method ?? "GET") === "GET") return fail(404, 10007);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const error = await script.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain("got no response within 120 seconds");
  });

  it("reports a create whose response body timed out as unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if ((init?.method ?? "GET") === "GET") return fail(404, 10007);
      const response = new Response("{}");
      vi.spyOn(response, "text").mockRejectedValue(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
      return response;
    });

    const error = await script.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain("got no response within 120 seconds");
  });

  it("reports a create whose upload failed on the network as unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if ((init?.method ?? "GET") === "GET") return fail(404, 10007);
      throw new TypeError("fetch failed");
    });

    const error = await script.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain("failed on the network: fetch failed");
  });

  it("throws a TypeError from outside the request as it is", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if ((init?.method ?? "GET") === "GET") return fail(404, 10007);
      return ok({});
    });
    vi.spyOn(FormData.prototype, "set").mockImplementationOnce(() => {
      throw new TypeError("x is not a function");
    });

    const error = await script.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(error).toBeInstanceOf(TypeError);
  });

  it("waits and tries again when the API is rate limited", async () => {
    mockFetch(
      () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
    );

    const error = await script.read!({
      AccountId: "acc",
      ScriptName: "app--dev--api",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.retryAfterMs).toBe(2_000);
  });

  it("waits and tries again when Cloudflare reports a rate limit with status 200", async () => {
    mockFetch(() =>
      Response.json({
        success: false,
        errors: [
          {
            code: 971,
            message: "Please wait and consider throttling your request speed",
          },
        ],
      }),
    );

    await expect(
      script.read!({ AccountId: "acc", ScriptName: "app--dev--api" }),
    ).rejects.toBeInstanceOf(ResourceOperationPendingError);
  });

  it("doesn't take over a Worker that has no versions", async () => {
    mockFetch(() => fail(404, 0, "Worker app--dev--api has no versions"));

    await expect(script.create(params)).rejects.toThrow(
      "A Worker named app--dev--api already exists",
    );
    expect(calls).toHaveLength(1);
  });

  it("reads a Worker that has no versions as existing, without settings", async () => {
    mockFetch(() => fail(404, 0, "Worker app--dev--api has no versions"));

    await expect(
      script.read!({ AccountId: "acc", ScriptName: "app--dev--api" }),
    ).resolves.toEqual({
      AccountId: "acc",
      ScriptName: "app--dev--api",
      CompatibilityDate: undefined,
      CompatibilityFlags: undefined,
    });
  });

  it("renames a namespace whose class changed, and deletes one whose declaration is gone", async () => {
    mockFetch(() => ok({}));

    await script.update!(
      { AccountId: "acc", ScriptName: "app--dev--api" },
      {} as any,
      {
        ...params,
        DurableObjectNamespaces: [{ id: "counters", className: "Tally" }],
      },
      {
        ...params,
        DurableObjectNamespaces: [
          { id: "counters", className: "Counter" },
          { id: "rooms", className: "Room" },
        ],
      },
    );

    const { metadata } = await uploadedMetadata(calls[0]!);
    expect(metadata.exports).toEqual({
      Tally: { type: "durable-object", storage: "sqlite" },
      Counter: {
        type: "durable-object",
        state: "renamed",
        renamed_to: "Tally",
      },
      Room: { type: "durable-object", state: "deleted" },
    });
  });

  it("reads the compatibility settings, with the flags sorted", async () => {
    mockFetch(() =>
      ok({
        compatibility_date: "2026-10-12",
        compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
        bindings: [],
      }),
    );

    await expect(
      script.read!({ AccountId: "acc", ScriptName: "app--dev--api" }),
    ).resolves.toEqual({
      AccountId: "acc",
      ScriptName: "app--dev--api",
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    });
    expect(calls[0]!.url).toMatch(/\/scripts\/app--dev--api\/settings$/);
  });

  it("reads a missing Worker as not found, and deletes it without an error", async () => {
    mockFetch(() => fail(404, 10007, "This Worker does not exist"));
    const key = { AccountId: "acc", ScriptName: "app--dev--api" };

    await expect(script.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(script.delete(key, {} as any)).resolves.toBeUndefined();
  });

  describe("delete of a Worker that other Workers refer to", () => {
    const key = { AccountId: "acc", ScriptName: "app--dev--api" };
    const scriptUrl =
      "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api";
    const dependent = (ScriptName: string) => ({
      id: `worker:${ScriptName}`,
      type: WorkerScript.type,
      params: { AccountId: "acc", ScriptName },
    });
    type Refused = { status: number; code: number };
    const byService = { status: 400, code: 10142 };

    // Refuses the delete without `force`, and answers the two reads of the
    // references.
    function mockReferenced(
      refused: Refused,
      references: object,
      tails: object[] = [],
    ) {
      mockFetch(({ method, url }) => {
        if (url.endsWith("/references")) return ok(references);
        if (url.includes("/tails/by-consumer/")) return ok(tails);
        if (method === "DELETE" && !url.endsWith("?force=true")) {
          return fail(refused.status, refused.code, "still referenced");
        }
        return ok();
      });
    }
    const deletes = () =>
      calls.filter(({ method }) => method === "DELETE").map(({ url }) => url);

    it("forces the delete when every Worker that binds it as a service is a dependent", async () => {
      mockReferenced(byService, {
        services: {
          incoming: [{ name: "API", service: "app--dev--reports" }],
          outgoing: [],
        },
      });

      await script.delete(key, {} as any, undefined, {
        dependents: [dependent("app--dev--reports")],
      });

      expect(deletes()).toEqual([scriptUrl, `${scriptUrl}?force=true`]);
    });

    it("forces the delete when every Worker that binds a namespace it hosts is a dependent", async () => {
      mockReferenced(
        { status: 403, code: 10064 },
        {
          services: { incoming: [], outgoing: [] },
          durable_objects: [
            { name: "COUNTERS", service: "app--dev--api" },
            { name: "COUNTERS", service: "app--dev--reports" },
          ],
        },
      );

      await script.delete(key, {} as any, undefined, {
        dependents: [dependent("app--dev--reports")],
      });

      expect(deletes()).toEqual([scriptUrl, `${scriptUrl}?force=true`]);
    });

    it("does not force the delete when a Worker that is not a dependent refers to it, and names that Worker", async () => {
      mockReferenced(byService, {
        services: {
          incoming: [
            { name: "API", service: "app--dev--reports" },
            { name: "API", service: "other--prod--site" },
          ],
          outgoing: [],
        },
      });

      await expect(
        script.delete(key, {} as any, undefined, {
          dependents: [dependent("app--dev--reports")],
        }),
      ).rejects.toThrow(
        'Cannot delete the Worker "app--dev--api": the Worker "other--prod--site" refers to it, and this deployment does not manage that reference.',
      );
      expect(deletes()).toEqual([scriptUrl]);
    });

    it("does not force the delete when it is told of no dependents", async () => {
      mockReferenced(byService, {
        services: {
          incoming: [{ name: "API", service: "app--dev--reports" }],
          outgoing: [],
        },
      });

      await expect(script.delete(key, {} as any)).rejects.toThrow(
        'the Worker "app--dev--reports" refers to it',
      );
      expect(deletes()).toEqual([scriptUrl]);
    });

    it("does not force the delete when a Pages project or a tail producer refers to it", async () => {
      mockReferenced(
        byService,
        {
          services: {
            incoming: [{ name: "API", service: "app--dev--reports" }],
            outgoing: [],
            pages_function: true,
          },
        },
        [{ producer: { script: "logs--prod--source" } }],
      );

      await expect(
        script.delete(key, {} as any, undefined, {
          dependents: [dependent("app--dev--reports")],
        }),
      ).rejects.toThrow(
        'the Worker "logs--prod--source" and a Pages project refer to it',
      );
      expect(deletes()).toEqual([scriptUrl]);
    });

    it("throws a refusal for another reason as it is, without reading the references", async () => {
      mockReferenced({ status: 422, code: 100109 }, {});

      await expect(
        script.delete(key, {} as any, undefined, {
          dependents: [dependent("app--dev--reports")],
        }),
      ).rejects.toThrow("still referenced (100109)");
      expect(calls).toHaveLength(1);
    });
  });

  it("names the account variable when it is not set", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");

    await expect(
      script.deriveParams({
        id: script.id,
        config: script.config,
        deps: {
          code: {
            output: { filePath: params.CodeFilePath, fileSha256: codeSha256 },
          },
        } as any,
      }),
    ).rejects.toThrow("Set CLOUDFLARE_ACCOUNT_ID");
  });

  it("shows an API error that has no code without one", async () => {
    mockFetch(() =>
      Response.json(
        {
          success: false,
          errors: [{ message: "No access to the specified resource." }],
        },
        { status: 403 },
      ),
    );

    await expect(
      script.read!({ AccountId: "acc", ScriptName: "app--dev--api" }),
    ).rejects.toThrow(
      /failed with status 403: No access to the specified resource\.$/,
    );
  });

  it("rejects a replacement when the account changes", () => {
    const { AccountId } = script.schema;
    if (AccountId.propertyType !== "param") throw new Error("not a param");

    expect(AccountId.rejectReplace?.("old", "new")).toMatch(
      /CLOUDFLARE_ACCOUNT_ID is new, but this Worker was deployed to the account old/,
    );
  });
});

describe("durableObjectExports", () => {
  it.each([
    [
      "whose namespace was removed, or had its id changed",
      [{ id: "b", className: "Counter" }],
      [{ id: "a", className: "Counter" }],
    ],
    [
      "whose namespace now has another class",
      [
        { id: "a", className: "Counter2" },
        { id: "b", className: "Counter" },
      ],
      [{ id: "a", className: "Counter" }],
    ],
  ])("fails when a new namespace takes a class %s", (_, hosted, previous) => {
    expect(() => durableObjectExports(hosted, previous)).toThrow(
      `The Durable Object namespace "b" has the class Counter, which the namespace "a" had before.`,
    );
  });
});

describe("WorkerSubdomain", () => {
  const subdomain = new WorkerSubdomain("worker:api:subdomain", {
    dependencies: { script },
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

  it("reads a Worker that is not on workers.dev as not found", async () => {
    mockFetch(() => ok({ enabled: false, previews_enabled: false }));

    await expect(subdomain.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});
