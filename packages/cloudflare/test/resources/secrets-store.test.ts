import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import {
  declareSecret,
  Redacted,
  runWithSecretContext,
  type SecretContextOptions,
  type Source,
} from "@notation/core";
import { collectResourceGraph } from "@notation/resource";
import { SecretsStore, SecretsStoreSecret } from "src/resources/secrets-store";

type Call = { method: string; url: URL; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(url)),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
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

const STORES = "/client/v4/accounts/acc/secrets_store/stores";

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("SecretsStore", () => {
  const store = new SecretsStore("secrets-store");

  it("adopts the account's store", async () => {
    mockFetch(() => ok([{ id: "store", name: "default_secrets_store" }]));

    await expect(store.create({ AccountId: "acc" })).resolves.toEqual({
      StoreId: "store",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls[0]!.url.pathname).toBe(STORES);
  });

  it("creates a store with the dashboard's name when the account has none", async () => {
    mockFetch((call) =>
      call.method === "GET"
        ? ok([])
        : ok({ id: "new", name: "default_secrets_store" }),
    );

    await expect(store.create({ AccountId: "acc" })).resolves.toEqual({
      StoreId: "new",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { name: "default_secrets_store" },
    });
  });

  it("adopts the store of a deploy that created it first", async () => {
    let lists = 0;
    mockFetch((call) => {
      if (call.method === "POST")
        return fail(400, 1001, "maximum_stores_exceeded");
      lists += 1;
      return lists === 1 ? ok([]) : ok([{ id: "theirs", name: "x" }]);
    });

    await expect(store.create({ AccountId: "acc" })).resolves.toEqual({
      StoreId: "theirs",
    });
  });

  it("fails with Cloudflare's error when the create fails and there is still no store", async () => {
    mockFetch((call) =>
      call.method === "POST"
        ? fail(403, 10000, "Authentication error")
        : ok([]),
    );

    await expect(store.create({ AccountId: "acc" })).rejects.toThrow(
      "Authentication error",
    );
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch((call) => (call.method === "POST" ? fail(502, 0) : ok([])));

    await expect(store.create({ AccountId: "acc" })).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("reads a missing store as not found", async () => {
    mockFetch(() => fail(404, 1001, "store_not_found"));

    await expect(
      store.read!({ AccountId: "acc", StoreId: "store" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("leaves the store on delete", async () => {
    mockFetch(() => ok());

    await store.delete({ AccountId: "acc", StoreId: "store" }, {} as any);
    expect(calls).toHaveLength(0);
  });
});

describe("SecretsStoreSecret", () => {
  const resource = new SecretsStoreSecret("secret:stripe-key", {
    config: {
      Name: "shop--dev--stripe-key",
      StageScoped: true,
      ValueFrom: { Secret: "stripe-key", Source: "prompt" },
    },
    dependencies: {} as any,
  });

  const sourced = {
    AccountId: "acc",
    StoreId: "store",
    Name: "shop--dev--stripe-key",
    StageScoped: true,
    ValueFrom: {
      Secret: "stripe-key",
      Source: "vault",
      Key: "STRIPE_KEY",
      Version: "14",
    },
  };
  const params = {
    ...sourced,
    ValueFrom: { Secret: "stripe-key", Source: "prompt" },
  };
  const key = { AccountId: "acc", StoreId: "store", Name: params.Name };

  const listed = (fields: Record<string, unknown> = {}) => ({
    id: "s1",
    name: params.Name,
    status: "active",
    ...fields,
  });

  const vault: Source = {
    name: "vault",
    has: async () => true,
    get: async () => new Redacted("sk_from_vault"),
  };

  // Runs `fn` as deploy does: with the secret declared, with a source or
  // without one.
  function deploying<T>(
    fn: () => Promise<T>,
    options: Partial<SecretContextOptions> & { source?: Source } = {},
  ): Promise<T> {
    const { source, ...context } = options;
    return runWithSecretContext(
      { stage: "dev", runId: "run", ...context },
      async () => {
        await collectResourceGraph(() =>
          declareSecret({
            id: "stripe-key",
            resource,
            ...(source ? { source, key: "STRIPE_KEY" } : {}),
          }),
        );
        return fn();
      },
    );
  }

  const writes = () =>
    calls
      .filter((call) => call.method !== "GET")
      .map(({ method, url, body }) => ({ method, path: url.pathname, body }));

  it("creates a missing secret with its source's value, scoped to Workers", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([]) : ok([listed()])));

    await deploying(() => resource.create(sourced), { source: vault });

    expect(calls[0]!.url.pathname).toBe(`${STORES}/store/secrets`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      search: params.Name,
      page: "1",
    });
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${STORES}/store/secrets`,
        body: [
          { name: params.Name, value: "sk_from_vault", scopes: ["workers"] },
        ],
      },
    ]);
  });

  it("overwrites the value of a secret that exists, from its source", async () => {
    mockFetch((call) =>
      call.method === "GET"
        ? ok([listed({ id: "other", name: `${params.Name}-old` }), listed()])
        : ok(listed()),
    );

    await deploying(() => resource.update!(key, sourced, sourced, {} as any), {
      source: vault,
    });

    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `${STORES}/store/secrets/s1`,
        body: { value: "sk_from_vault" },
      },
    ]);
  });

  it("asks for the value of a missing secret without a source", async () => {
    mockFetch((call) =>
      call.method === "GET" ? ok([listed({ status: "deleted" })]) : ok([]),
    );
    const prompt = vi.fn(async () => "hunter2");

    await deploying(() => resource.create(params), { prompt });

    expect(prompt).toHaveBeenCalledWith({ id: "stripe-key", stage: "dev" });
    expect(writes()).toMatchObject([
      { method: "POST", body: [{ name: params.Name, value: "hunter2" }] },
    ]);
  });

  it("records a secret without a source that exists, without asking", async () => {
    mockFetch(() => ok([listed()]));
    const prompt = vi.fn(async () => "hunter2");

    await deploying(() => resource.create(params), { prompt });
    await deploying(() => resource.update!(key, params, params, {} as any), {
      prompt,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("overwrites a secret without a source with the value that notation secret set supplied", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([listed()]) : ok()));
    const supplied = { id: "stripe-key", value: new Redacted("sk_set") };

    await deploying(() => resource.create(params), { supplied });

    expect(writes()).toMatchObject([
      { method: "PATCH", body: { value: "sk_set" } },
    ]);
  });

  it("fails with the command to run for a missing secret when no one can be asked", async () => {
    mockFetch(() => ok([]));

    await expect(deploying(() => resource.create(params))).rejects.toThrow(
      "Secret `stripe-key` isn't set for stage dev. Run `notation secret set stripe-key --stage dev`.",
    );
    expect(writes()).toEqual([]);
  });

  it("reads the secret's ID by its name", async () => {
    mockFetch(() => ok([listed({ id: "s2" })]));

    await expect(resource.read!(key)).resolves.toEqual({
      ...key,
      SecretId: "s2",
    });
  });

  it("reads the next page when the first is full", async () => {
    mockFetch((call) =>
      call.url.searchParams.get("page") === "1"
        ? ok(
            Array.from({ length: 100 }, (_, i) =>
              listed({ id: `x${i}`, name: `${params.Name}-${i}` }),
            ),
          )
        : ok([listed({ id: "s2" })]),
    );

    await expect(resource.read!(key)).resolves.toMatchObject({
      SecretId: "s2",
    });
    expect(calls).toHaveLength(2);
  });

  it("reads a missing secret, or a missing store, as not found", async () => {
    mockFetch(() => ok([]));
    await expect(resource.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );

    vi.restoreAllMocks();
    mockFetch(() => fail(404, 1001, "store_not_found"));
    await expect(resource.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("deletes a stage-scoped secret", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([listed()]) : ok()));

    await resource.delete(key, { ...params, SecretId: "s1" });

    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]!.url.pathname).toBe(`${STORES}/store/secrets/s1`);
  });

  it("leaves a secret with an explicit name on delete", async () => {
    mockFetch(() => ok([listed()]));

    await resource.delete(key, {
      ...params,
      StageScoped: false,
      SecretId: "s1",
    });

    expect(calls).toHaveLength(0);
  });

  it("does nothing on delete when the secret is already gone", async () => {
    mockFetch((call) =>
      call.method === "GET"
        ? ok([listed()])
        : fail(404, 1001, "secret_not_found"),
    );

    await expect(
      resource.delete(key, { ...params, SecretId: "s1" }),
    ).resolves.toBeUndefined();
  });
});
