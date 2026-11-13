import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { AccountToken } from "src/resources/tokens";

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

const TOKENS = "/client/v4/accounts/acc/tokens";
const SECRETS = "/client/v4/accounts/acc/secrets_store/stores/store/secrets";
const VALUE = "token-value-sentinel";

const policies = [
  {
    effect: "allow" as const,
    permissionGroups: ["Workers Scripts Write"],
    resources: { "com.cloudflare.api.account.acc": "*" },
  },
];

const params = {
  AccountId: "acc",
  StoreId: "store",
  Name: "shop--dev--deploy",
  Policies: policies,
};

const key = {
  AccountId: "acc",
  StoreId: "store",
  Name: "shop--dev--deploy",
  TokenId: "t1",
};

const token = new AccountToken("token:deploy", {
  config: { Name: params.Name, Policies: policies },
  dependencies: {} as any,
});

type Routes = {
  groups?: () => Response;
  createToken?: () => Response;
  getToken?: () => Response;
  listSecrets?: () => Response;
  createSecret?: () => Response;
  patchSecret?: () => Response;
};

function route(routes: Routes) {
  mockFetch((call) => {
    const path = call.url.pathname;
    if (path === `${TOKENS}/permission_groups`) {
      return (
        routes.groups ??
        (() => ok([{ id: "g1", name: "Workers Scripts Write" }]))
      )();
    }
    if (path === TOKENS && call.method === "POST") {
      return (routes.createToken ?? (() => ok({ id: "t1", value: VALUE })))();
    }
    if (path.startsWith(`${TOKENS}/`) && call.method === "GET") {
      return (routes.getToken ?? (() => ok({ name: params.Name })))();
    }
    if (path.startsWith(`${TOKENS}/`)) return ok();
    if (path === SECRETS && call.method === "GET") {
      return (routes.listSecrets ?? (() => ok([])))();
    }
    if (path === SECRETS && call.method === "POST") {
      return (
        routes.createSecret ?? (() => ok([{ id: "s1", name: params.Name }]))
      )();
    }
    if (path.startsWith(`${SECRETS}/`) && call.method === "PATCH") {
      return (routes.patchSecret ?? (() => ok()))();
    }
    return ok();
  });
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AccountToken", () => {
  it("creates the token with its permission groups by ID, and writes its value to a new secret", async () => {
    route({});

    await expect(token.create(params)).resolves.toEqual({ TokenId: "t1" });

    const groups = calls[0]!;
    expect(groups.url.searchParams.get("name")).toBe("Workers Scripts Write");
    expect(calls.find((c) => c.url.pathname === TOKENS)).toMatchObject({
      method: "POST",
      body: {
        name: "shop--dev--deploy",
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: "g1" }],
            resources: { "com.cloudflare.api.account.acc": "*" },
          },
        ],
      },
    });
    expect(
      calls.find((c) => c.url.pathname === SECRETS && c.method === "POST"),
    ).toMatchObject({
      body: [{ name: "shop--dev--deploy", value: VALUE, scopes: ["workers"] }],
    });
  });

  it("overwrites the value of a secret that has the token's name", async () => {
    route({
      listSecrets: () =>
        ok([{ id: "old", name: params.Name, status: "active" }]),
    });

    await token.create(params);

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url.pathname).toBe(`${SECRETS}/old`);
    expect(patch.body).toEqual({ value: VALUE });
  });

  it("doesn't return the value", async () => {
    route({});

    const result = await token.create(params);

    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it("fails for a permission group that Cloudflare doesn't have, before it creates the token", async () => {
    route({
      groups: () => ok([{ id: "g2", name: "Workers Scripts Write Plus" }]),
    });

    await expect(token.create(params)).rejects.toThrow(
      `Cloudflare has no API token permission group named "Workers Scripts Write".`,
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("deletes the new token when its value can't be written", async () => {
    route({ createSecret: () => fail(400, 1001, "store_not_found") });

    await expect(token.create(params)).rejects.toThrow("store_not_found");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(calls.at(-1)!.url.pathname).toBe(`${TOKENS}/t1`);
  });

  it("reports a create whose response was a server error as unknown", async () => {
    route({ createToken: () => fail(502, 0, "bad gateway") });

    const error = await token.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain(
      "If the account acc has an API token named shop--dev--deploy that the deploy doesn't track, delete it in the dashboard.",
    );
  });

  it("reads the policies by name, and the ID of the secret", async () => {
    route({
      getToken: () =>
        ok({
          name: params.Name,
          policies: [
            {
              id: "p1",
              effect: "allow",
              permission_groups: [{ id: "g1", name: "Workers Scripts Write" }],
              resources: { "com.cloudflare.api.account.acc": "*" },
            },
          ],
        }),
      listSecrets: () =>
        ok([{ id: "s1", name: params.Name, status: "active" }]),
    });

    await expect(token.read!(key)).resolves.toEqual({
      ...key,
      SecretId: "s1",
      Policies: policies,
    });
  });

  it("reads a missing token as not found", async () => {
    route({ getToken: () => fail(404, 1003, "Invalid API Token") });

    await expect(token.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("fails to read when the secret is missing, and says to rotate the token", async () => {
    route({});

    await expect(token.read!(key)).rejects.toThrow(
      "Rotate the token: change the id of its accountToken() declaration, and deploy.",
    );
  });

  it("updates the token's policies in place", async () => {
    route({});

    await token.update!(key, params, params, {} as any);

    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      body: {
        name: params.Name,
        policies: [{ permission_groups: [{ id: "g1" }] }],
      },
    });
    expect(calls.at(-1)!.url.pathname).toBe(`${TOKENS}/t1`);
  });

  it("deletes the token and its secret", async () => {
    route({
      listSecrets: () =>
        ok([{ id: "s1", name: params.Name, status: "active" }]),
    });

    await token.delete(key, {} as any);

    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname),
    ).toEqual([`${TOKENS}/t1`, `${SECRETS}/s1`]);
  });

  it("adds the permission it needs to a 403", async () => {
    route({
      groups: () =>
        fail(403, 9109, "Unauthorized to access requested resource"),
    });

    await expect(token.create(params)).rejects.toThrow(
      "it needs the Account API Tokens: Edit permission",
    );
  });
});
