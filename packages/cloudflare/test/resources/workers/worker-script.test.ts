import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { decideAction } from "@notation/reconciler";
import {
  WorkerScript,
  type WorkerScriptInstance,
} from "src/resources/workers/worker-script";
import { calls, fail, mockFetch, ok, type Call } from "../../mock-api";

let root: string;
const code = "export default { fetch() { return new Response('ok'); } };";
const codeSha256 = crypto.createHash("sha256").update(code).digest("base64");

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
    CompatibilityDate: params.CompatibilityDate,
  },
  dependencies: {} as any,
});

const isDeploymentsRead = (call: Call) =>
  call.method === "GET" && call.url.endsWith("/deployments");

// Leaves out the read of the deployments before an upload, which the tests
// under "gradual rollout" check.
const requests = () => calls.filter((call) => !isDeploymentsRead(call));

async function uploadedMetadata(call: Call) {
  const form = call.body as FormData;
  const module = form.get("index.mjs") as File;
  return {
    metadata: JSON.parse(form.get("metadata") as string),
    module: { type: module.type, text: await module.text() },
  };
}

// Answers a read of the Worker's settings as not found until the first
// upload, and every other call with `respond`.
function untilUploaded(respond: (call: Call) => Response = () => ok({})) {
  let uploaded = false;
  return (call: Call) => {
    if (call.method === "PUT") uploaded = true;
    if (call.method === "GET" && call.url.endsWith("/settings")) {
      return uploaded ? ok({}) : fail(404, 10007, "not found");
    }
    return respond(call);
  };
}

beforeEach(() => {
  calls.length = 0;
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
    mockFetch(untilUploaded());

    await script.create(params);

    const put = requests()[1]!;
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
        keep_bindings: ["secret_text"],
        exports: { Counter: { type: "durable-object", storage: "sqlite" } },
        observability: { enabled: false },
        logpush: false,
        tail_consumers: [],
      },
      module: { type: "application/javascript+module", text: code },
    });
  });

  it("uploads a KV namespace binding", async () => {
    mockFetch(untilUploaded());
    const binding = {
      type: "kv_namespace" as const,
      name: "CACHE",
      namespace_id: "ns1",
    };

    await script.create({ ...params, Bindings: [binding] });

    const { metadata } = await uploadedMetadata(requests()[1]!);
    expect(metadata.bindings).toEqual([binding]);
  });

  it("uploads R2 bucket and JSON bindings", async () => {
    mockFetch(untilUploaded());
    const bindings = [
      {
        type: "r2_bucket" as const,
        name: "UPLOADS",
        bucket_name: "uploads",
        jurisdiction: "eu" as const,
      },
      {
        type: "json" as const,
        name: "CONFIG",
        json: { retries: 3, regions: ["weur"] },
      },
    ];

    await script.create({ ...params, Bindings: bindings });

    const { metadata } = await uploadedMetadata(requests()[1]!);
    expect(metadata.bindings).toEqual(bindings);
  });

  it("leaves exports out for a Worker that hosts no namespace", async () => {
    mockFetch(untilUploaded());

    await script.create({ ...params, DurableObjectNamespaces: [] });

    const { metadata } = await uploadedMetadata(requests()[1]!);
    expect(metadata).not.toHaveProperty("exports");
    expect(metadata).not.toHaveProperty("containers");
  });

  it("declares the container classes in the upload", async () => {
    mockFetch(untilUploaded());

    await script.create({
      ...params,
      DurableObjectNamespaces: [
        { id: "counters", className: "Counter" },
        { id: "sandboxes", className: "Sandbox", container: true },
      ],
    });

    const { metadata } = await uploadedMetadata(requests()[1]!);
    expect(metadata.containers).toEqual([{ class_name: "Sandbox" }]);
    expect(metadata.exports).toEqual({
      Counter: { type: "durable-object", storage: "sqlite" },
      Sandbox: { type: "durable-object", storage: "sqlite" },
    });
  });

  it("reports a Worker that exists already as ResourceAlreadyExistsError", async () => {
    mockFetch(() => ok({ compatibility_date: "2026-01-01" }));

    const created = script.create(params);
    await expect(created).rejects.toThrow(
      "A Worker named app--dev--api already exists in the Cloudflare account acc",
    );
    await expect(created).rejects.toSatisfy(ResourceAlreadyExistsError.is);
    expect(requests()).toHaveLength(1);
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
    expect(requests()).toHaveLength(1);
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
      vi.spyOn(response, "arrayBuffer").mockRejectedValue(
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

    const error = await script.read!(
      {
        AccountId: "acc",
        ScriptName: "app--dev--api",
      },
      undefined,
      {} as any,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.retryAfterMs).toBe(2_000);
    // A create lookup must not read a throttled read as a found resource.
    expect(error.throttled).toBe(true);
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
      script.read!(
        { AccountId: "acc", ScriptName: "app--dev--api" },
        undefined,
        {} as any,
      ),
    ).rejects.toBeInstanceOf(ResourceOperationPendingError);
  });

  it.each([0, 10007])(
    "doesn't take over a Worker that has no versions (code %i)",
    async (code) => {
      mockFetch(() => fail(404, code, "Worker app--dev--api has no versions"));

      await expect(script.create(params)).rejects.toThrow(
        "A Worker named app--dev--api already exists",
      );
      expect(requests()).toHaveLength(1);
    },
  );

  it("reads a Worker that has no versions as existing, without settings", async () => {
    mockFetch(() => fail(404, 0, "Worker app--dev--api has no versions"));

    await expect(
      script.read!(
        { AccountId: "acc", ScriptName: "app--dev--api" },
        undefined,
        {} as any,
      ),
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

    expect(requests()).toHaveLength(1);
    const { metadata } = await uploadedMetadata(requests()[0]!);
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

  describe("move of a namespace to another Worker", () => {
    const key = { AccountId: "acc", ScriptName: "app--dev--api" };
    const rooms = { id: "rooms", className: "Room" };
    const roomsBinding = {
      type: "durable_object_namespace" as const,
      name: "ROOMS",
      class_name: "Room",
    };
    const web = {
      namespaceId: "rooms",
      workerId: "web",
      scriptName: "app--dev--web",
      nameBody: "app--dev--web",
    };
    const arriving = {
      ...params,
      Bindings: [...params.Bindings, roomsBinding],
      DurableObjectNamespaces: [...params.DurableObjectNamespaces, rooms],
      DurableObjectTransferSources: [web],
    };
    const namespacesPage = (page: number) =>
      `https://api.cloudflare.com/client/v4/accounts/acc/workers/durable_objects/namespaces?page=${page}&per_page=1000`;
    const namespacesUrl = namespacesPage(1);
    const isListing = ({ method, url }: Call) =>
      method === "GET" && url.includes("/durable_objects/namespaces?");
    // Lists the namespaces on the first page, and none on later pages.
    const respondWith = (namespaces: unknown[]) => (call: Call) =>
      isListing(call)
        ? ok(call.url === namespacesUrl ? namespaces : [])
        : ok({});

    it("transfers a new namespace that a Worker which binds it hosts", async () => {
      mockFetch(
        respondWith([
          { script: "app--dev--web", class: "Room", use_sqlite: true },
          { script: "app--dev--web", class: "Lobby", use_sqlite: true },
          { script: "app--dev--other", class: "Room", use_sqlite: true },
          { script: "app--dev--api", class: "Counter", use_sqlite: true },
        ]),
      );

      await script.update!(key, {} as any, arriving, params);

      expect(requests().map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${namespacesUrl}`,
        `GET ${namespacesPage(2)}`,
        "PUT https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api",
        "PATCH https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--web/settings",
        "PUT https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/app--dev--api",
      ]);
      const expecting = (await uploadedMetadata(requests()[2]!)).metadata;
      expect(expecting.bindings).toEqual(params.Bindings);
      expect(expecting.exports).toEqual({
        Counter: { type: "durable-object", storage: "sqlite" },
        Room: {
          type: "durable-object",
          storage: "sqlite",
          state: "expecting-transfer",
          transfer_from: "app--dev--web",
        },
      });
      const settings = (requests()[3]!.body as FormData).get(
        "settings",
      ) as string;
      expect(JSON.parse(settings)).toEqual({
        exports: {
          Room: {
            type: "durable-object",
            state: "transferred",
            transferred_to: "app--dev--api",
          },
          Lobby: { type: "durable-object", storage: "sqlite" },
        },
      });
      const settled = (await uploadedMetadata(requests()[4]!)).metadata;
      expect(settled.bindings).toEqual(arriving.Bindings);
      expect(settled.exports).toEqual({
        Counter: { type: "durable-object", storage: "sqlite" },
        Room: { type: "durable-object", storage: "sqlite" },
      });
    });

    it("fails before any upload when the Worker that a namespace moves to is created in this deploy", async () => {
      mockFetch((call) =>
        isListing(call)
          ? respondWith([
              { script: "app--dev--web", class: "Room", use_sqlite: true },
            ])(call)
          : fail(404, 10007, "not found"),
      );

      await expect(script.create(arriving)).rejects.toThrow(
        'Deploy would move the Durable Object namespaces "rooms" from the Worker app--dev--web to the Worker app--dev--api, which this deploy creates. Deploy can move a namespace only to a Worker that exists. Deploy app--dev--api first without the namespaces, and move them in a later deploy.',
      );
      expect(requests().some(({ method }) => method === "PUT")).toBe(false);
    });

    it("lists the account's namespaces once in a create, and uploads once", async () => {
      mockFetch(untilUploaded((call) => (isListing(call) ? ok([]) : ok({}))));

      await script.create(arriving);

      expect(requests().filter(isListing)).toHaveLength(1);
      expect(requests().filter(({ method }) => method !== "GET")).toHaveLength(
        1,
      );
    });

    it("fails when the list of the account's namespaces doesn't end", async () => {
      mockFetch((call) =>
        isListing(call)
          ? ok([
              { script: "app--dev--other", class: "Lobby", use_sqlite: true },
            ])
          : ok({}),
      );

      await expect(
        script.update!(key, {} as any, arriving, params),
      ).rejects.toThrow(
        "Cloudflare listed more than 100 pages of Durable Object namespaces in the account acc, so deploy stopped listing them.",
      );
      expect(requests().filter(isListing)).toHaveLength(100);
    });

    it("creates the namespace when no Worker that binds it hosts its class", async () => {
      mockFetch(
        respondWith([
          { script: "app--dev--other", class: "Room", use_sqlite: true },
        ]),
      );

      await script.update!(key, {} as any, arriving, params);

      expect(requests().map(({ method }) => method)).toEqual([
        "GET",
        "GET",
        "PUT",
      ]);
      const { metadata } = await uploadedMetadata(requests()[2]!);
      expect(metadata.exports.Room).toEqual({
        type: "durable-object",
        storage: "sqlite",
      });
    });

    it("lists the account's namespaces until a page is empty, as a page can have fewer than asked for", async () => {
      mockFetch((call) => {
        if (!isListing(call)) return ok({});
        if (call.url === namespacesPage(1)) {
          return ok([
            { script: "app--dev--other", class: "Lobby", use_sqlite: true },
          ]);
        }
        if (call.url === namespacesPage(2)) {
          return ok([
            { script: "app--dev--web", class: "Room", use_sqlite: true },
          ]);
        }
        return ok([]);
      });

      await script.update!(key, {} as any, arriving, params);

      expect(requests().filter(isListing)).toHaveLength(3);
      expect(
        requests()
          .map(({ method }) => method)
          .slice(3),
      ).toEqual(["PUT", "PATCH", "PUT"]);
    });

    it("doesn't list the account's namespaces when no new namespace has a Worker that binds it", async () => {
      mockFetch(() => ok({}));

      await script.update!(key, {} as any, arriving, {
        ...params,
        DurableObjectNamespaces: arriving.DurableObjectNamespaces,
      });
      await script.update!(
        key,
        {} as any,
        { ...arriving, DurableObjectTransferSources: undefined },
        params,
      );

      expect(requests().map(({ method }) => method)).toEqual(["PUT", "PUT"]);
    });

    describe("from a Worker with no state record", () => {
      const lostWeb = {
        namespaceId: "rooms",
        workerId: "web",
        nameBody: "app--dev--web",
      };
      const lost = {
        ...arriving,
        DurableObjectTransferSources: [lostWeb],
      };

      it("fails before any upload when a Worker with a generated name hosts the class, and names it", async () => {
        const found = "app--dev--web-1a2b3c4d";
        mockFetch(
          respondWith([{ script: found, class: "Room", use_sqlite: true }]),
        );

        await expect(
          script.update!(key, {} as any, lost, params),
        ).rejects.toThrow(
          `The Durable Object namespace "rooms" is new to the Worker app--dev--api. The Worker "web" binds it and has no state record, and the Worker ${found} in the Cloudflare account hosts a namespace with its class Room.`,
        );
        expect(requests().some(({ method }) => method === "PUT")).toBe(false);
      });

      it("fails a create too", async () => {
        mockFetch((call) =>
          isListing(call)
            ? respondWith([
                {
                  script: "app--dev--web-1a2b3c4d",
                  class: "Room",
                  use_sqlite: true,
                },
              ])(call)
            : fail(404, 10007, "not found"),
        );

        await expect(script.create(lost)).rejects.toThrow(
          "the Worker app--dev--web-1a2b3c4d in the Cloudflare account hosts",
        );
        expect(requests().some(({ method }) => method === "PUT")).toBe(false);
      });

      it.each([
        ["another Worker's name", "app--dev--webhooks-1a2b3c4d"],
        ["an ending that isn't an instance", "app--dev--web-1a2b3c4"],
      ])(
        "creates the namespace when the Worker that hosts the class has %s",
        async (_, found) => {
          mockFetch(
            respondWith([{ script: found, class: "Room", use_sqlite: true }]),
          );

          await script.update!(key, {} as any, lost, params);

          expect(requests().map(({ method }) => method)).toEqual([
            "GET",
            "GET",
            "PUT",
          ]);
        },
      );

      it("moves the namespace from a Worker in state whose name the Worker with no record could have", async () => {
        mockFetch(
          respondWith([
            {
              script: "app--dev--web-5e6f7a8b",
              class: "Room",
              use_sqlite: true,
            },
          ]),
        );

        await script.update!(
          key,
          {} as any,
          {
            ...lost,
            DurableObjectTransferSources: [
              lostWeb,
              {
                namespaceId: "rooms",
                workerId: "web-2",
                scriptName: "app--dev--web-5e6f7a8b",
                nameBody: "app--dev--web-2",
              },
            ],
          },
          params,
        );

        expect(
          requests()
            .map(({ method }) => method)
            .slice(2),
        ).toEqual(["PUT", "PATCH", "PUT"]);
      });

      it("matches a name that was cut to fit the limit by its cut body", async () => {
        const body = "app--dev--a-very-long-worker-id-that-is-cut-he";
        mockFetch(
          respondWith([
            { script: `${body}-0badf00d`, class: "Room", use_sqlite: true },
          ]),
        );

        await expect(
          script.update!(
            key,
            {} as any,
            {
              ...lost,
              DurableObjectTransferSources: [{ ...lostWeb, nameBody: body }],
            },
            params,
          ),
        ).rejects.toThrow(`the Worker ${body}-0badf00d in the Cloudflare`);
      });
    });

    it.each([
      ["false", { use_sqlite: false }],
      ["missing", {}],
    ])(
      "fails before any upload when the Worker it moves from has a namespace whose use_sqlite is %s",
      async (_, storage) => {
        mockFetch(
          respondWith([
            { script: "app--dev--web", class: "Room", use_sqlite: true },
            { script: "app--dev--web", class: "Legacy", ...storage },
          ]),
        );

        await expect(
          script.update!(key, {} as any, arriving, params),
        ).rejects.toThrow(
          /^Cannot move the Durable Object namespace "rooms" from the Worker app--dev--web: app--dev--web also hosts the namespace of the class Legacy, which Cloudflare's namespace list doesn't show as using SQLite storage\. Notation can move a namespace only from a Worker whose namespaces all use SQLite\.$/,
        );
        expect(requests().map(({ method }) => method)).toEqual(["GET", "GET"]);
      },
    );

    it("leaves a namespace that moved out of the exports of the Worker it moved from", async () => {
      mockFetch(() => ok({}));

      await script.update!(
        { AccountId: "acc", ScriptName: "app--dev--web" },
        {} as any,
        {
          ...params,
          ScriptName: "app--dev--web",
          Bindings: [{ ...roomsBinding, script_name: "app--dev--api" }],
          DurableObjectNamespaces: [],
          BoundDurableObjects: [{ ...rooms, scriptName: "app--dev--api" }],
        },
        {
          ...params,
          ScriptName: "app--dev--web",
          DurableObjectNamespaces: [
            { id: "counters", className: "Counter" },
            rooms,
          ],
        },
      );

      const { metadata } = await uploadedMetadata(requests()[0]!);
      expect(metadata.exports).toEqual({
        Counter: { type: "durable-object", state: "deleted" },
      });
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
      script.read!(
        { AccountId: "acc", ScriptName: "app--dev--api" },
        undefined,
        {} as any,
      ),
    ).resolves.toEqual({
      AccountId: "acc",
      ScriptName: "app--dev--api",
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
    });
    expect(requests()[0]!.url).toMatch(/\/scripts\/app--dev--api\/settings$/);
  });

  // Under load, Cloudflare can report a new Worker as not found after a read
  // that found it, so a wait in create can't cover the read after it.
  it("has deploy retry a not-found read straight after a create", () => {
    expect(script.readLagsCreate).toBe(true);
  });

  it("reads a missing Worker as not found, and deletes it without an error", async () => {
    mockFetch(() => fail(404, 10007, "This Worker does not exist"));
    const key = { AccountId: "acc", ScriptName: "app--dev--api" };

    await expect(
      script.read!(key, undefined, {} as any),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
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
      requests()
        .filter(({ method }) => method === "DELETE")
        .map(({ url }) => url);

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
      expect(requests()).toHaveLength(1);
    });
  });

  it("fails, and doesn't read the Worker as missing, on a 404 without Cloudflare's not-found code", async () => {
    mockFetch(() => fail(404, 7003, "Could not route"));
    const key = { AccountId: "acc", ScriptName: "app--dev--api" };

    const read = await script.read!(key, undefined, {} as any).catch((e) => e);
    expect(read).not.toBeInstanceOf(ResourceNotFoundError);
    expect(read.message).toContain("failed with status 404");
    await expect(script.delete(key, {} as any)).rejects.toThrow(
      "failed with status 404",
    );
  });

  it("names the account variable when it is not set", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");

    await expect(
      script.deriveParams({
        id: script.id,
        config: { CompatibilityDate: params.CompatibilityDate },
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
      script.read!(
        { AccountId: "acc", ScriptName: "app--dev--api" },
        undefined,
        {} as any,
      ),
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

describe("rejectChange", () => {
  const counters = { id: "counters", className: "Counter" };
  const rooms = { id: "rooms", className: "Room" };
  const previous = { ...params, DurableObjectNamespaces: [counters, rooms] };
  type Params = NonNullable<
    Parameters<NonNullable<typeof WorkerScript.rejectChange>>[1]
  >;
  const reject = (
    desired: Partial<Params> | undefined,
    replace = false,
    before: Partial<Params> = {},
  ) =>
    WorkerScript.rejectChange?.(
      { ...previous, ...before },
      desired && { ...previous, ...desired },
      { replace },
    );
  const lost =
    /^Deploy would delete the Durable Object namespaces "counters" \(class Counter\), "rooms" \(class Room\) of the Worker app--dev--api,/;

  it("allows a change of class, and the delete of a namespace that is unprotected in state", () => {
    expect(
      reject(
        { DurableObjectNamespaces: [{ id: "counters", className: "Tally" }] },
        false,
        { UnprotectedDurableObjects: ["rooms"] },
      ),
    ).toBeUndefined();
  });

  it("reads protection from state, not from code", () => {
    expect(
      reject({
        DurableObjectNamespaces: [counters],
        UnprotectedDurableObjects: ["rooms"],
      }),
    ).toMatch(/^Deploy would delete the Durable Object namespaces "rooms"/);
  });

  describe("move to another Worker", () => {
    const bound = (className = "Room", id = "rooms") => ({
      BoundDurableObjects: [{ id, className, scriptName: "app--dev--web" }],
    });

    it("allows a protected namespace that the Worker binds on another Worker now", () => {
      expect(
        reject({ DurableObjectNamespaces: [counters], ...bound() }),
      ).toBeUndefined();
    });

    it("rejects a move that also changes the class", () => {
      expect(
        reject({ DurableObjectNamespaces: [counters], ...bound("Lobby") }),
      ).toBe(
        `The Durable Object namespace "rooms" would move from the Worker app--dev--api to app--dev--web, and its class would change from Room to Lobby. Deploy can't move a namespace and change its class at once. Move it with the class Room, and change the class in a later deploy.`,
      );
    });

    it("allows a move at plan to a Worker whose name is unknown, and names it as another Worker", () => {
      const unknown = { $unknown: "after-apply" } as never;
      const toNew = (className: string) => ({
        BoundDurableObjects: [{ id: "rooms", className, scriptName: unknown }],
      });
      expect(
        reject({ DurableObjectNamespaces: [counters], ...toNew("Room") }),
      ).toBeUndefined();
      expect(
        reject({ DurableObjectNamespaces: [counters], ...toNew("Lobby") }),
      ).toMatch(
        /^The Durable Object namespace "rooms" would move from the Worker app--dev--api to another Worker, and its class would change/,
      );
    });

    it("rejects a bound namespace that takes the class of another namespace of this Worker", () => {
      expect(
        reject(
          { DurableObjectNamespaces: [counters], ...bound("Room", "lobbies") },
          false,
          { UnprotectedDurableObjects: ["rooms"] },
        ),
      ).toMatch(
        /^The Durable Object namespace "lobbies" has the class Room, which "rooms" had on the Worker app--dev--api, so "lobbies" could get the objects of "rooms"\./,
      );
    });

    it("rejects the delete or the replacement of the Worker that a namespace moves from", () => {
      expect(reject({ ...bound() }, true)).toMatch(lost);
    });

    describe("to this Worker", () => {
      const lobbies = { id: "lobbies", className: "Lobby" };
      const sources = {
        DurableObjectTransferSources: [
          {
            namespaceId: "lobbies",
            workerId: "web",
            scriptName: "app--dev--web",
            nameBody: "app--dev--web",
          },
        ],
      };

      it("rejects a namespace that may move here in the deploy that renames or deletes another one", () => {
        expect(
          reject({
            DurableObjectNamespaces: [
              { id: "counters", className: "Tally" },
              rooms,
              lobbies,
            ],
            ...sources,
          }),
        ).toBe(
          `Deploy may move the Durable Object namespaces "lobbies" (class Lobby) to the Worker app--dev--api from another Worker that binds them, and would also rename or delete the classes Counter of app--dev--api. Deploy can't do both in one deploy. Make the two changes in separate deploys.`,
        );
        expect(
          reject(
            { DurableObjectNamespaces: [counters, lobbies], ...sources },
            false,
            { UnprotectedDurableObjects: ["rooms"] },
          ),
        ).toMatch(/^Deploy may move .* the classes Room of app--dev--api\./);
      });

      it("allows a namespace that may move here, or one that no other Worker binds, alone", () => {
        expect(
          reject({
            DurableObjectNamespaces: [counters, rooms, lobbies],
            ...sources,
          }),
        ).toBeUndefined();
        expect(
          reject({
            DurableObjectNamespaces: [
              { id: "counters", className: "Tally" },
              rooms,
              lobbies,
            ],
          }),
        ).toBeUndefined();
      });
    });
  });

  it("leaves the check to deploy when the list is unknown at plan", () => {
    const unknown = { $unknown: "after-apply" } as never;
    expect(reject({ DurableObjectNamespaces: unknown })).toBeUndefined();
  });

  it("allows any change to a Worker that hosted no namespace", () => {
    expect(
      WorkerScript.rejectChange?.(
        { ...params, DurableObjectNamespaces: [] },
        undefined,
        { replace: false },
      ),
    ).toBeUndefined();
  });

  it("rejects a protected namespace that the Worker no longer hosts", () => {
    expect(reject({ DurableObjectNamespaces: [counters] })).toBe(
      `Deploy would delete the Durable Object namespaces "rooms" (class Room) of the Worker app--dev--api, with all their objects, which can't be undone. To delete them, first deploy \`protect: false\` on $durableObject({ id: "rooms" }) while this Worker still hosts them. To move a namespace to another Worker instead, keep binding it from this Worker.`,
    );
  });

  it("rejects a change of id, and says to change the id back", () => {
    expect(
      reject({
        DurableObjectNamespaces: [
          { id: "tallies", className: "Counter" },
          rooms,
        ],
      }),
    ).toBe(
      `The id of the Durable Object namespace "counters" (class Counter) of the Worker app--dev--api would change to "tallies". A namespace's id can't change: deploy would delete the namespace with all its objects, which can't be undone. Change the id back to "counters".`,
    );
  });

  it("rejects a change of id and class, and says to change the id back if it changed", () => {
    expect(
      reject({
        DurableObjectNamespaces: [{ id: "tallies", className: "Tally" }, rooms],
      }),
    ).toMatch(
      /^Deploy would delete the Durable Object namespaces "counters" \(class Counter\) of the Worker app--dev--api, with all their objects, which can't be undone\. If the id of a namespace changed, change it back\. To delete them,/,
    );
  });

  it("rejects a namespace that takes the class of an unprotected one", () => {
    expect(
      reject(
        {
          DurableObjectNamespaces: [
            counters,
            { id: "lobbies", className: "Room" },
          ],
        },
        false,
        { UnprotectedDurableObjects: ["rooms"] },
      ),
    ).toMatch(
      /^The Durable Object namespace "lobbies" has the class Room, which "rooms" had on the Worker app--dev--api, so "lobbies" could get the objects of "rooms"\./,
    );
  });

  it("rejects the delete or the replacement of a Worker with protected namespaces", () => {
    expect(reject(undefined)).toMatch(lost);
    expect(reject({ ScriptName: "app--dev--api2" }, true)).toMatch(lost);
    expect(reject({}, true)).toMatch(lost);
    expect(
      reject(undefined, false, { UnprotectedDurableObjects: ["counters"] }),
    ).toMatch(/^Deploy would delete the Durable Object namespaces "rooms"/);
  });

  it("allows the delete or the replacement of a Worker whose namespaces are all unprotected in state", () => {
    const before = { UnprotectedDurableObjects: ["counters", "rooms"] };
    expect(reject(undefined, false, before)).toBeUndefined();
    expect(
      reject({ ScriptName: "app--dev--api2" }, true, before),
    ).toBeUndefined();
  });

  describe("through decideAction", () => {
    const stateNode = {
      version: 1,
      id: "worker:api",
      type: WorkerScript.type,
      provider: WorkerScript.provider,
      config: {},
      params: previous,
      output: previous,
      lastOperation: "create" as const,
      lastOperationAt: "2026-10-12T00:00:00.000Z",
    };
    const decide = (desired: Partial<Params>) =>
      decideAction({
        resource: script,
        stateNode,
        params: { ...previous, ...desired },
      });

    it("updates the Worker when only protection changes", () => {
      expect(decide({ UnprotectedDurableObjects: ["rooms"] })).toMatchObject({
        decision: "update",
        patch: { UnprotectedDurableObjects: ["rooms"] },
      });
    });

    it("doesn't update the Worker when only the bound namespaces or the transfer sources change", () => {
      expect(
        decide({
          BoundDurableObjects: [
            { id: "lobbies", className: "Lobby", scriptName: "app--dev--web" },
          ],
          DurableObjectTransferSources: [
            {
              namespaceId: "rooms",
              workerId: "web",
              scriptName: "app--dev--web",
              nameBody: "app--dev--web",
            },
          ],
        }),
      ).toEqual({ decision: "noop" });
    });

    it("rejects the delete of a protected namespace in the deploy that unprotects it", () => {
      expect(() =>
        decide({
          DurableObjectNamespaces: [counters],
          UnprotectedDurableObjects: ["rooms"],
        }),
      ).toThrow(
        /^worker:api: Deploy would delete the Durable Object namespaces "rooms"/,
      );
    });
  });
});

describe("WorkerScript log settings", () => {
  const key = { AccountId: "acc", ScriptName: "app--dev--api" };
  const logs = {
    ...params,
    Observability: { enabled: true, head_sampling_rate: 0.1 },
    Logpush: true,
    TailConsumers: [{ service: "app--dev--tail" }],
  };

  it("sends the observability, Logpush and tail consumer settings in the upload", async () => {
    mockFetch(untilUploaded());

    await script.create(logs);

    const { metadata } = await uploadedMetadata(requests()[1]!);
    expect(metadata).toMatchObject({
      observability: { enabled: true, head_sampling_rate: 0.1 },
      logpush: true,
      tail_consumers: [{ service: "app--dev--tail" }],
    });
  });

  it("reads the settings that the params set", async () => {
    mockFetch(() =>
      ok({
        compatibility_date: "2026-10-12",
        logpush: false,
        observability: {
          enabled: true,
          head_sampling_rate: 0.5,
          logs: { enabled: true, invocation_logs: true },
        },
        tail_consumers: [
          { service: "app--dev--audit" },
          { service: "app--dev--tail" },
        ],
      }),
    );

    const read = await script.read!(key, undefined, logs);

    expect(read).toMatchObject({
      Observability: { enabled: true, head_sampling_rate: 0.5 },
      Logpush: false,
      TailConsumers: [
        { service: "app--dev--audit" },
        { service: "app--dev--tail" },
      ],
    });
  });

  it("reads the tail consumers in the order of the params when Cloudflare has the same services", async () => {
    mockFetch(() =>
      ok({
        tail_consumers: [
          { service: "app--dev--tail" },
          { service: "app--dev--audit" },
        ],
      }),
    );
    const consumers = [
      { service: "app--dev--audit" },
      { service: "app--dev--tail" },
    ];

    const read = await script.read!(key, undefined, {
      ...params,
      TailConsumers: consumers,
    });

    expect(read).toMatchObject({ TailConsumers: consumers });
  });

  it("reads Workers Logs as off when the settings leave it out", async () => {
    mockFetch(() => ok({ compatibility_date: "2026-10-12" }));

    const read = await script.read!(key, undefined, logs);

    expect(read).toMatchObject({
      Observability: { enabled: false },
      Logpush: false,
      TailConsumers: [],
    });
  });

  it("reads the sampling rate as Cloudflare's default when Workers Logs is on and the settings leave it out", async () => {
    mockFetch(() => ok({ observability: { enabled: true } }));

    const read = await script.read!(key, undefined, logs);

    expect(read).toMatchObject({
      Observability: { enabled: true, head_sampling_rate: 1 },
    });
  });

  it("reads no log settings when the params set none", async () => {
    mockFetch(() =>
      ok({
        logpush: true,
        observability: { enabled: true },
        tail_consumers: [],
      }),
    );

    const read = await script.read!(key, undefined, params);

    expect(read).not.toHaveProperty("Observability");
    expect(read).not.toHaveProperty("Logpush");
    expect(read).not.toHaveProperty("TailConsumers");
  });

  it("rejects a sampling rate above 1 when it is declared", () => {
    expect(
      () =>
        new WorkerScript("worker:sampled", {
          config: {
            CompatibilityDate: params.CompatibilityDate,
            Observability: { enabled: true, head_sampling_rate: 2 },
          },
          dependencies: {} as any,
        }),
    ).toThrow(/head_sampling_rate/);
  });
});

describe("WorkerScript secrets", () => {
  const secrets = { API_KEY: "sk_live", ADMIN: "hunter2" };
  const withSecrets = { ...params, Secrets: secrets };
  const isSecretsList = (call: Call) =>
    call.method === "GET" && call.url.endsWith("/app--dev--api/secrets");
  const withSecretList =
    (names: string[], respond: (call: Call) => Response = () => ok({})) =>
    (call: Call) =>
      isSecretsList(call)
        ? ok(names.map((name) => ({ name, type: "secret_text" })))
        : respond(call);

  const secretBindings = async (call: Call) =>
    (await uploadedMetadata(call)).metadata.bindings.filter(
      (binding: { type: string }) => binding.type === "secret_text",
    );

  const upload = () => requests().find((call) => call.method === "PUT")!;

  it("sends each secret in the upload that creates the Worker, without listing the secrets before it", async () => {
    mockFetch(untilUploaded(withSecretList(["API_KEY", "ADMIN"])));

    await script.create(withSecrets);

    const putIndex = calls.findIndex((call) => call.method === "PUT");
    expect(calls.findIndex(isSecretsList)).toBeGreaterThan(putIndex);
    expect(await secretBindings(upload())).toEqual([
      { type: "secret_text", name: "API_KEY", text: "sk_live" },
      { type: "secret_text", name: "ADMIN", text: "hunter2" },
    ]);
    expect((await uploadedMetadata(upload())).metadata.keep_bindings).toEqual([
      "secret_text",
    ]);
  });

  it("sends only the secrets that an update receives a value for, and keeps the others", async () => {
    mockFetch(withSecretList(["ADMIN", "API_KEY"]));
    const changed = { ...params, Secrets: { API_KEY: "sk_rotated" } };

    await script.update!(
      params as any,
      {} as any,
      {
        ...params,
        Secrets: { API_KEY: "sk_rotated", ADMIN: undefined },
      } as any,
      changed,
    );

    expect(await secretBindings(upload())).toEqual([
      { type: "secret_text", name: "API_KEY", text: "sk_rotated" },
    ]);
    expect((await uploadedMetadata(upload())).metadata.keep_bindings).toEqual([
      "secret_text",
    ]);
    const putIndex = calls.findIndex((call) => call.method === "PUT");
    expect(calls.slice(0, putIndex).some(isSecretsList)).toBe(false);
    expect(requests().filter((call) => call.method === "DELETE")).toHaveLength(
      0,
    );
  });

  it("doesn't list the secrets after an upload that sends none", async () => {
    mockFetch(withSecretList(["ADMIN"]));

    await script.update!(
      params as any,
      {} as any,
      { ...params, Secrets: { ADMIN: undefined } } as any,
      { ...params, Secrets: { ADMIN: "hunter2" } },
    );

    expect(await secretBindings(upload())).toEqual([]);
    expect(calls.filter(isSecretsList)).toHaveLength(0);
  });

  describe("list of the secrets after the upload", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function settle(promise: Promise<unknown>) {
      let settled = false;
      promise.finally(() => (settled = true)).catch(() => {});
      for (let step = 0; !settled && step < 1_000; step++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(50);
      }
    }

    it("waits until the list has every secret that the upload sent", async () => {
      let lists = 0;
      mockFetch((call) => {
        if (!isSecretsList(call)) return ok({});
        lists += 1;
        const names = lists <= 1 ? ["API_KEY"] : ["API_KEY", "ADMIN"];
        return ok(names.map((name) => ({ name, type: "secret_text" })));
      });

      const updated = script.update!(
        params as any,
        {} as any,
        withSecrets,
        params,
      );
      await settle(updated);

      await expect(updated).resolves.toBeUndefined();
      expect(calls.filter(isSecretsList)).toHaveLength(2);
    });

    it("waits through a list that fails with not found after the upload that creates the Worker", async () => {
      let lists = 0;
      mockFetch(
        untilUploaded((call) => {
          if (!isSecretsList(call)) return ok({});
          lists += 1;
          if (lists <= 2) return fail(404, 10007, "not found");
          return ok(
            ["API_KEY", "ADMIN"].map((name) => ({ name, type: "secret_text" })),
          );
        }),
      );

      const created = script.create(withSecrets);
      await settle(created);

      await expect(created).resolves.toBeUndefined();
      expect(calls.filter(isSecretsList)).toHaveLength(3);
    });

    it("fails when the list still lacks a sent secret 15 seconds after the upload", async () => {
      mockFetch(withSecretList(["API_KEY"]));

      const updated = script.update!(
        params as any,
        {} as any,
        withSecrets,
        params,
      );
      await settle(updated);

      await expect(updated).rejects.toThrow(
        "still left the secrets ADMIN out of its list 15 seconds later",
      );
    });
  });

  it("deletes each secret that state has and the params don't, after the upload", async () => {
    mockFetch(withSecretList(["API_KEY"]));

    await script.update!(
      params as any,
      {} as any,
      { ...params, Secrets: { API_KEY: "sk_live" } },
      withSecrets,
    );

    expect(
      requests()
        .filter((call) => call.method !== "GET")
        .map((call) => [call.method, call.url.replace(/.*\/scripts\//, "")]),
    ).toEqual([
      ["PUT", "app--dev--api"],
      ["DELETE", "app--dev--api/secrets/ADMIN"],
    ]);
  });

  it("doesn't delete a secret whose name the upload binds as a plain binding", async () => {
    mockFetch(withSecretList(["API_KEY"]));
    const plain = {
      ...params,
      Bindings: [
        ...params.Bindings,
        { type: "plain_text" as const, name: "ADMIN", text: "visible" },
      ],
      Secrets: { API_KEY: "sk_live" },
    };

    await script.update!(params as any, {} as any, plain, withSecrets);

    expect(
      requests()
        .filter((call) => call.method !== "GET")
        .map((call) => call.method),
    ).toEqual(["PUT"]);
  });

  it("reads the entries of Secrets whose secret the Worker still has", async () => {
    mockFetch((call) =>
      isSecretsList(call)
        ? ok([
            { name: "API_KEY", type: "secret_text" },
            { name: "ADMIN", type: "secret_key" },
          ])
        : ok({ compatibility_date: "2026-01-01" }),
    );

    const read = await script.read!(
      { AccountId: "acc", ScriptName: "app--dev--api" },
      undefined,
      withSecrets,
    );

    expect((read as { Secrets?: unknown }).Secrets).toEqual({
      API_KEY: "sk_live",
    });
  });

  it("doesn't list the secrets in a read without Secrets", async () => {
    mockFetch(() => ok({ compatibility_date: "2026-01-01" }));

    const read = await script.read!(
      { AccountId: "acc", ScriptName: "app--dev--api" },
      undefined,
      params,
    );

    expect((read as { Secrets?: unknown }).Secrets).toBeUndefined();
    expect(calls.some(isSecretsList)).toBe(false);
  });
});

describe("WorkerScript during a gradual rollout", () => {
  const split = {
    deployments: [
      {
        id: "d2",
        created_on: "2026-11-15T10:00:00Z",
        strategy: "percentage",
        versions: [
          { version_id: "3c9e", percentage: 50 },
          { version_id: "81fa", percentage: 50 },
        ],
      },
      {
        id: "d1",
        created_on: "2026-11-14T10:00:00Z",
        strategy: "percentage",
        versions: [{ version_id: "3c9e", percentage: 100 }],
      },
    ],
  };
  const puts = () => calls.filter((call) => call.method === "PUT");

  it("fails an update, and uploads nothing", async () => {
    mockFetch((call) => (isDeploymentsRead(call) ? ok(split) : ok({})));

    await expect(
      script.update!(params as any, {} as any, params, params),
    ).rejects.toThrow(
      "The Worker app--dev--api is in a gradual rollout: 50% on version 3c9e, 50% on version 81fa. An upload would end the rollout. Finish or cancel it in Cloudflare, then deploy again.",
    );
    expect(calls.filter(isDeploymentsRead)).toHaveLength(1);
    expect(puts()).toEqual([]);
  });

  it("doesn't read the deployments in a create", async () => {
    mockFetch(untilUploaded());

    await script.create(params);

    expect(calls.filter(isDeploymentsRead)).toEqual([]);
  });

  it("uploads when the latest deployment has one version", async () => {
    mockFetch((call) =>
      isDeploymentsRead(call)
        ? ok({ deployments: [split.deployments[1], split.deployments[0]] })
        : ok({}),
    );

    await script.update!(params as any, {} as any, params, params);

    expect(puts()).toHaveLength(1);
  });

  it("uploads when the latest deployment lists a second version at 0%", async () => {
    const finished = {
      ...split.deployments[0],
      versions: [
        { version_id: "81fa", percentage: 100 },
        { version_id: "3c9e", percentage: 0 },
      ],
    };
    mockFetch((call) =>
      isDeploymentsRead(call) ? ok({ deployments: [finished] }) : ok({}),
    );

    await script.update!(params as any, {} as any, params, params);

    expect(puts()).toHaveLength(1);
  });
});

// The type checker checks these tests. The calls are in a function that is
// not called.
describe("WorkerScript contributions", () => {
  it("takes a ~state ref only where undefined fits", () => {
    const host = {} as WorkerScriptInstance;
    const binder = {} as WorkerScriptInstance;
    const source = {
      namespaceId: "counters",
      workerId: "web",
      nameBody: "app--dev--web",
    };
    expectTypeOf(() => {
      const name = binder["~state"].outputRef("ScriptName");
      host.contribute({
        DurableObjectTransferSources: [{ ...source, scriptName: name }],
      });
      host.contribute({
        // @ts-expect-error namespaceId is required
        DurableObjectTransferSources: [{ ...source, namespaceId: name }],
      });
      host.contribute({
        // @ts-expect-error an item of the list can't be undefined
        DurableObjectTransferSources: [name],
      });
      host.contribute({
        // @ts-expect-error each item gives every required field
        DurableObjectTransferSources: [{ namespaceId: "counters" }],
      });
      host.contribute({
        Bindings: [
          {
            type: "durable_object_namespace",
            name: "COUNTERS",
            class_name: "Counter",
            script_name: name,
          },
        ],
      });
      host.contribute({
        // @ts-expect-error a binding's name is required
        Bindings: [{ type: "service", name, service: "app--dev--web" }],
      });
    }).toBeFunction();
  });
});
