import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
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

const ok = (result: unknown = null, result_info?: object) =>
  Response.json({ success: true, errors: [], result, result_info });

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
    config: { Name: "shop--dev--stripe-key", StageScoped: true },
    dependencies: {} as any,
  });

  const params = {
    AccountId: "acc",
    StoreId: "store",
    Name: "shop--dev--stripe-key",
    StageScoped: true,
  };
  const key = { AccountId: "acc", StoreId: "store", Name: params.Name };

  const listed = (fields: Record<string, unknown> = {}) => ({
    id: "s1",
    name: params.Name,
    status: "active",
    ...fields,
  });

  it("finds a secret that exists, by name", async () => {
    mockFetch(() =>
      ok([listed({ id: "other", name: `${params.Name}-old` }), listed()]),
    );

    await resource.create(params);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(`${STORES}/store/secrets`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      search: params.Name,
      page: "1",
    });
  });

  it("fails with the command that sets a secret that doesn't exist", async () => {
    mockFetch(() => ok([listed({ status: "deleted" })]));

    await expect(resource.create(params)).rejects.toThrow(
      "The secret shop--dev--stripe-key isn't in the Secrets Store store of the Cloudflare account acc. Notation doesn't write secret values yet. Create the secret with `wrangler secrets-store secret create store --name shop--dev--stripe-key --scopes workers --remote`",
    );
  });

  it("fails before any request when the secret has a ValueFrom", async () => {
    mockFetch(() => ok([listed()]));

    await expect(
      resource.create({ ...params, ValueFrom: { Source: "prompt" } }),
    ).rejects.toThrow("can't write a secret's value");
    expect(calls).toHaveLength(0);
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
            { total_pages: 2 },
          )
        : ok([listed({ id: "s2" })], { total_pages: 2 }),
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
