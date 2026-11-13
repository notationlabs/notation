import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { decideDriftAction } from "@notation/reconciler";
import { clearSecretValues, scrubSecretValues } from "@notation/utils";
import { AccountToken, sortedPolicies } from "src/resources/tokens";

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

const policy = (permissionGroups: string[], resources = ACCOUNT) => ({
  effect: "allow" as const,
  permissionGroups,
  resources,
});

const ACCOUNT = { "com.cloudflare.api.account.acc": "*" };
const ZONES = {
  "com.cloudflare.api.account.acc": {
    "com.cloudflare.api.account.zone.*": "*",
  },
};

const policies = [policy(["Workers Scripts Write"])];

const params = {
  AccountId: "acc",
  StoreId: "store",
  Name: "shop--dev--deploy",
  Policies: [policy(["g1"])],
};

const key = {
  AccountId: "acc",
  StoreId: "store",
  Name: "shop--dev--deploy",
  TokenId: "t1",
};

const tokenWith = (Policies: ReturnType<typeof policy>[]) =>
  new AccountToken("token:deploy", {
    config: { Name: params.Name, Policies },
    dependencies: {
      store: { output: { AccountId: "acc", StoreId: "store" } },
    } as any,
  });

const token = tokenWith(policies);

const LOGS_WRITE = [
  {
    id: "g-account",
    name: "Logs Write",
    scopes: ["com.cloudflare.api.account"],
  },
  {
    id: "g-zone",
    name: "Logs Write",
    scopes: ["com.cloudflare.api.account.zone"],
  },
];

type Routes = {
  groups?: (name: string) => Response;
  createToken?: () => Response;
  getToken?: () => Response;
  listTokens?: (page: string) => Response;
  deleteToken?: () => Response;
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
        (() =>
          ok([
            {
              id: "g1",
              name: "Workers Scripts Write",
              scopes: ["com.cloudflare.api.account"],
            },
          ]))
      )(call.url.searchParams.get("name")!);
    }
    if (path === TOKENS && call.method === "GET") {
      return (routes.listTokens ?? (() => ok([])))(
        call.url.searchParams.get("page")!,
      );
    }
    if (path === TOKENS && call.method === "POST") {
      return (routes.createToken ?? (() => ok({ id: "t1", value: VALUE })))();
    }
    if (path.startsWith(`${TOKENS}/`) && call.method === "GET") {
      return (routes.getToken ?? (() => ok({ name: params.Name })))();
    }
    if (path.startsWith(`${TOKENS}/`) && call.method === "DELETE") {
      return (routes.deleteToken ?? (() => ok()))();
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
  clearSecretValues();
});

describe("AccountToken", () => {
  it("creates the token with its permission groups by ID, and writes its value to a new secret", async () => {
    route({});

    await expect(token.create(params)).resolves.toEqual({ TokenId: "t1" });

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

  describe("permission groups", () => {
    it("replaces each name with the group's ID, and sorts the groups", async () => {
      route({
        groups: (name) =>
          ok([{ id: name === "Workers Scripts Write" ? "g2" : "g1", name }]),
      });

      const params = await tokenWith([
        policy(["Workers Scripts Write", "Account Settings Read"]),
      ]).getParams();

      expect(params.Policies).toEqual([policy(["g1", "g2"])]);
      expect(calls.map((c) => c.url.searchParams.get("name")).sort()).toEqual([
        "Account Settings Read",
        "Workers Scripts Write",
      ]);
    });

    it("fails for a name that Cloudflare doesn't have", async () => {
      route({
        groups: () => ok([{ id: "g2", name: "Workers Scripts Write Plus" }]),
      });

      await expect(token.getParams()).rejects.toThrow(
        `Cloudflare has no API token permission group named "Workers Scripts Write".`,
      );
    });

    it("picks the group of a shared name by the scope of the resources", async () => {
      route({ groups: () => ok(LOGS_WRITE) });

      const account = await tokenWith([policy(["Logs Write"])]).getParams();
      const zones = await tokenWith([
        policy(["Logs Write"], ZONES as any),
      ]).getParams();

      expect(account.Policies[0]!.permissionGroups).toEqual(["g-account"]);
      expect(zones.Policies[0]!.permissionGroups).toEqual(["g-zone"]);
    });

    it("lists the groups of a shared name that the scope doesn't pick", async () => {
      route({ groups: () => ok(LOGS_WRITE) });
      const both = { ...ACCOUNT, "com.cloudflare.api.account.zone.z1": "*" };

      await expect(
        tokenWith([policy(["Logs Write"], both)]).getParams(),
      ).rejects.toThrow(
        `More than one API token permission group is named "Logs Write", and the scope of the policy's resources doesn't pick one: g-account (com.cloudflare.api.account), g-zone (com.cloudflare.api.account.zone). Give each scope its own policy.`,
      );
    });

    it("adds the permission it needs to a 403", async () => {
      route({
        groups: () =>
          fail(403, 9109, "Unauthorized to access requested resource"),
      });

      await expect(token.getParams()).rejects.toThrow(
        "it needs the Account API Tokens: Edit permission",
      );
    });
  });

  it("deletes the new token when its value can't be written", async () => {
    route({ createSecret: () => fail(400, 1001, "store_not_found") });

    await expect(token.create(params)).rejects.toThrow("store_not_found");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    expect(calls.at(-1)!.url.pathname).toBe(`${TOKENS}/t1`);
  });

  it("records the value, so that it is scrubbed from an error that echoes it", async () => {
    route({ createSecret: () => fail(400, 1001, `bad value ${VALUE}`) });

    const error = await token.create(params).catch((e) => e);
    expect(scrubSecretValues(error.message)).not.toContain(VALUE);
  });

  it("says to delete the new token by hand when its value can't be written and the token can't be deleted", async () => {
    route({
      createSecret: () => fail(400, 1001, "store_not_found"),
      deleteToken: () => fail(500, 0, "internal error"),
    });

    await expect(token.create(params)).rejects.toThrow(
      "store_not_found (1001). The API token t1 that was just created couldn't be deleted. Delete it in the dashboard.",
    );
  });

  it("reports a create whose response was a server error as unknown", async () => {
    route({ createToken: () => fail(502, 0, "bad gateway") });

    await expect(token.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("deletes every token with the name after a create with an unknown outcome, and reports none found", async () => {
    const page = (n: number) =>
      Array.from({ length: 50 }, (_, i) => ({
        id: `other-${n}-${i}`,
        name: `other-${i}`,
      }));
    route({
      listTokens: (n) =>
        n === "1"
          ? ok([...page(1).slice(1), { id: "lost-1", name: params.Name }])
          : ok([{ id: "lost-2", name: params.Name }, ...page(2).slice(0, 3)]),
    });

    await expect(token.find!(params, "token")).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(
      calls
        .filter((c) => c.url.pathname === TOKENS)
        .map((c) => c.url.searchParams.get("per_page")),
    ).toEqual(["50", "50"]);
    expect(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname),
    ).toEqual([`${TOKENS}/lost-1`, `${TOKENS}/lost-2`]);
  });

  it("reads the policies by group ID, and the ID of the secret", async () => {
    route({
      getToken: () =>
        ok({
          name: params.Name,
          policies: [
            {
              id: "p1",
              effect: "allow",
              permission_groups: [{ id: "g1" }],
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
      Policies: params.Policies,
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

  it("deletes the token, and its secret by the ID that its name has now", async () => {
    route({ listSecrets: () => ok([{ id: "s2", name: params.Name }]) });

    await token.delete(key, { SecretId: "s1" } as any);

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `DELETE ${TOKENS}/t1`,
      `GET ${SECRETS}`,
      `DELETE ${SECRETS}/s2`,
    ]);
  });

  describe("drift", () => {
    const twoGroups = [
      policy(["g2", "g1"]),
      { ...policy(["g3"]), effect: "deny" as const },
    ];

    const readPolicies = (policies: typeof twoGroups) => {
      route({
        getToken: () =>
          ok({
            name: params.Name,
            policies: policies.map((policy) => ({
              effect: policy.effect,
              permission_groups: policy.permissionGroups.map((id) => ({ id })),
              resources: policy.resources,
            })),
          }),
        listSecrets: () =>
          ok([{ id: "s1", name: params.Name, status: "active" }]),
      });
      return token.read!(key);
    };

    it("doesn't see the order of the policies and their groups as a change", async () => {
      const reversed = [...twoGroups].reverse().map((policy) => ({
        ...policy,
        permissionGroups: [...policy.permissionGroups].reverse(),
      }));
      const action = decideDriftAction({
        resource: token,
        params: { ...params, Policies: sortedPolicies(twoGroups) },
        driftRead: { kind: "present", output: await readPolicies(reversed) },
      });

      expect(action).toMatchObject({ decision: "noop" });
    });

    it("updates policies changed in the dashboard back to the declaration", async () => {
      const action = decideDriftAction({
        resource: token,
        params: { ...params, Policies: sortedPolicies(twoGroups) },
        driftRead: {
          kind: "present",
          output: await readPolicies([twoGroups[0]!]),
        },
      });

      expect(action).toMatchObject({ decision: "drift-update" });
    });
  });
});
