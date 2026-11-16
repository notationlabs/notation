import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generatedPhysicalName,
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
  const resource = new SecretsStoreSecret("stripe-key-secret", {
    config: { Value: "sk_live" },
    dependencies: {} as any,
  });

  const params = {
    AccountId: "acc",
    StoreId: "store",
    Name: "shop--dev--stripe-key-secret-3fa91c02",
    Value: "sk_live",
  };
  const key = { AccountId: "acc", StoreId: "store", Name: params.Name };

  const listed = (fields: Record<string, unknown> = {}) => ({
    id: "s1",
    name: params.Name,
    status: "active",
    ...fields,
  });

  const writes = () =>
    calls
      .filter((call) => call.method !== "GET")
      .map(({ method, url, body }) => ({ method, path: url.pathname, body }));

  it("generates a name of <app>--<stage>--<id>-<instance>, cut to 255 characters", () => {
    const scope = { app: "shop", stage: "dev" };
    expect(
      generatedPhysicalName(
        scope,
        "stripe-key-secret",
        "3fa91c02",
        { maxLength: 255 },
        {},
      ),
    ).toBe("shop--dev--stripe-key-secret-3fa91c02");

    const long = generatedPhysicalName(
      scope,
      "s".repeat(300),
      "3fa91c02",
      { maxLength: 255 },
      {},
    );
    expect(long).toHaveLength(255);
    expect(long).toMatch(/^shop--dev--s+-3fa91c02$/);
  });

  it("creates the secret with its value, scoped to Workers", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([]) : ok([listed()])));

    await resource.create(params);

    expect(calls[0]!.url.pathname).toBe(`${STORES}/store/secrets`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      search: params.Name,
      page: "1",
    });
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${STORES}/store/secrets`,
        body: [{ name: params.Name, value: "sk_live", scopes: ["workers"] }],
      },
    ]);
  });

  it("overwrites the value of a secret that a create with an unknown outcome made", async () => {
    mockFetch((call) =>
      call.method === "GET"
        ? ok([listed({ id: "other", name: `${params.Name}-old` }), listed()])
        : ok(listed()),
    );

    await resource.create(params);

    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `${STORES}/store/secrets/s1`,
        body: { value: "sk_live" },
      },
    ]);
  });

  it("writes the value on an update that receives it", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([listed()]) : ok()));
    const next = { ...params, Value: "sk_rotated" };

    await resource.update!(
      key,
      { Value: "sk_rotated" } as any,
      next,
      {} as any,
    );

    expect(writes()).toEqual([
      {
        method: "PATCH",
        path: `${STORES}/store/secrets/s1`,
        body: { value: "sk_rotated" },
      },
    ]);
  });

  it("writes nothing on an update without the value, as the credential's version is unchanged", async () => {
    mockFetch(() => ok([listed()]));

    await resource.update!(
      key,
      { Value: undefined } as any,
      { ...params, Value: undefined } as any,
      {} as any,
    );

    expect(calls).toEqual([]);
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

  it("deletes the secret by the ID that its name has now, not the ID in its record", async () => {
    mockFetch((call) =>
      call.method === "GET" ? ok([listed({ id: "s2" })]) : ok(),
    );

    await resource.delete(key, { ...params, SecretId: "s1" });

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET ${STORES}/store/secrets`,
      `DELETE ${STORES}/store/secrets/s2`,
    ]);
  });

  it("does nothing on delete when no secret has the name", async () => {
    mockFetch(() => ok([listed({ status: "deleted" })]));

    await expect(
      resource.delete(key, { ...params, SecretId: "s1" }),
    ).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("does nothing on delete when the secret is deleted after it is found", async () => {
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
