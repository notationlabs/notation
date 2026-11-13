import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithExecutionContext, scrubError } from "@notation/core";
import {
  applyDriftDetection,
  createStepRunner,
  runOperation,
  toEmitStep,
} from "@notation/reconciler";
import { ResourceNotFoundError } from "@notation/resource";
import { SecretsStore } from "src/resources/secrets-store/secrets-store";
import { AccountToken } from "src/resources/tokens/account-token";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
}

const ok = (result: unknown = null, result_info?: Record<string, unknown>) =>
  Response.json({
    success: true,
    errors: [],
    result,
    ...(result_info ? { result_info } : {}),
  });

const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc-1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeToken(overrides?: {
  Policies?: Array<{
    effect: "allow" | "deny";
    permission_groups: (string | { id: string })[];
    resources: Record<string, string | Record<string, string>>;
  }>;
  Condition?: { request_ip?: { in?: string[]; not_in?: string[] } };
  ExpiresOn?: string;
  NotBefore?: string;
}) {
  const store = new SecretsStore("secrets-store");
  store.setOutput({ AccountId: "acc-1", StoreId: "store-1" } as any);
  const token = new AccountToken("token:deploy-bot", {
    config: {
      Name: "shop--dev--deploy-bot",
      Policies: overrides?.Policies ?? [
        {
          effect: "allow",
          permission_groups: ["Workers Scripts Write"],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
      ...(overrides?.Condition ? { Condition: overrides.Condition } : {}),
      ...(overrides?.ExpiresOn ? { ExpiresOn: overrides.ExpiresOn } : {}),
      ...(overrides?.NotBefore ? { NotBefore: overrides.NotBefore } : {}),
    },
    dependencies: { store },
  });
  return { store, token };
}

describe("AccountToken resource", () => {
  it("deriveParams resolves permission group names across pages and disambiguates by scope", async () => {
    mockFetch((call) => {
      if (call.url.includes("/tokens/permission_groups")) {
        if (call.url.includes("page=2")) {
          return ok(
            [
              {
                id: "pg-logs-zone",
                name: "Logs Write",
                scopes: ["com.cloudflare.api.account.zone"],
              },
              {
                id: "pg-logs-account",
                name: "Logs Write",
                scopes: ["com.cloudflare.api.account"],
              },
            ],
            { page: 2, total_pages: 2 },
          );
        }
        return ok(
          [
            {
              id: "pg-workers",
              name: "Workers Scripts Write",
              scopes: ["com.cloudflare.api.account"],
            },
          ],
          { page: 1, total_pages: 2 },
        );
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const { token } = makeToken({
      Policies: [
        {
          effect: "allow",
          permission_groups: ["Workers Scripts Write", "Logs Write"],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
      Condition: {
        request_ip: { in: ["10.0.0.2/32", "10.0.0.1/32"], not_in: [] },
      },
      ExpiresOn: "2028-01-01T00:00:00.500Z",
    });

    const params = await token.getParams();
    expect(params).toEqual({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--deploy-bot",
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-logs-account" }, { id: "pg-workers" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
      Condition: { request_ip: { in: ["10.0.0.1/32", "10.0.0.2/32"] } },
      ExpiresOn: "2028-01-01T00:00:00Z",
    });
  });

  it("deriveParams skips permission_groups lookup when only { id } objects are provided", async () => {
    mockFetch(() => {
      throw new Error(
        "Should not fetch permission_groups when IDs are supplied",
      );
    });

    const { token } = makeToken({
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-2" }, { id: "pg-1" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
    });
    const params = await token.getParams();
    expect(params.Policies).toEqual([
      {
        effect: "allow",
        permission_groups: [{ id: "pg-1" }, { id: "pg-2" }],
        resources: { "com.cloudflare.api.account.acc-1": "*" },
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("create writes token value into Secrets Store with scopes ['workers'], records secret, and never returns value", async () => {
    const TOKEN_SENTINEL = "cfat_ONE_TIME_TOKEN_SENTINEL_1";
    const { token } = makeToken({
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-workers" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
    });

    mockFetch((call) => {
      if (
        call.method === "POST" &&
        call.url.endsWith("/accounts/acc-1/tokens")
      ) {
        return ok({
          id: "tok-1",
          name: "shop--dev--deploy-bot",
          value: TOKEN_SENTINEL,
          policies: call.body,
        });
      }
      if (
        call.method === "GET" &&
        call.url.includes("/secrets_store/stores/store-1/secrets")
      ) {
        return ok([]);
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/secrets_store/stores/store-1/secrets")
      ) {
        expect(call.body).toEqual([
          {
            name: "shop--dev--deploy-bot",
            value: TOKEN_SENTINEL,
            scopes: ["workers"],
          },
        ]);
        return ok([{ id: "sec-tok-1", name: "shop--dev--deploy-bot" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await runWithExecutionContext(
      { stage: "dev", executionId: "e1" },
      async () => {
        const created = await token.create({
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--deploy-bot",
          Policies: [
            {
              effect: "allow",
              permission_groups: [{ id: "pg-workers" }],
              resources: { "com.cloudflare.api.account.acc-1": "*" },
            },
          ],
        });
        expect(created).toEqual({ TokenId: "tok-1" });
        expect(JSON.stringify(created)).not.toContain(TOKEN_SENTINEL);
        const scrubbed = scrubError(
          new Error(`leak: ${TOKEN_SENTINEL}`),
        ) as Error;
        expect(scrubbed.message).not.toContain(TOKEN_SENTINEL);
        expect(scrubbed.message).toContain("[REDACTED]");
      },
    );
  });

  it("create cleans up the orphaned token if writing the secret to Secrets Store fails", async () => {
    const TOKEN_SENTINEL = "cfat_ORPHAN_SENTINEL_2";
    const { token } = makeToken({
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-workers" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
    });

    mockFetch((call) => {
      if (
        call.method === "POST" &&
        call.url.endsWith("/accounts/acc-1/tokens")
      ) {
        return ok({
          id: "tok-orphan",
          name: "shop--dev--deploy-bot",
          value: TOKEN_SENTINEL,
          policies: [],
        });
      }
      if (call.method === "GET" && call.url.includes("/secrets")) {
        return ok([]);
      }
      if (call.method === "POST" && call.url.includes("/secrets")) {
        return fail(500, 1000, "store write failed");
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith("/accounts/acc-1/tokens/tok-orphan")
      ) {
        return ok({ id: "tok-orphan" });
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await runWithExecutionContext(
      { stage: "dev", executionId: "e1" },
      async () => {
        await expect(
          token.create({
            AccountId: "acc-1",
            StoreId: "store-1",
            Name: "shop--dev--deploy-bot",
            Policies: [
              {
                effect: "allow",
                permission_groups: [{ id: "pg-workers" }],
                resources: { "com.cloudflare.api.account.acc-1": "*" },
              },
            ],
          }),
        ).rejects.toThrow();

        expect(
          calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
        ).toEqual([
          "POST /client/v4/accounts/acc-1/tokens",
          "GET /client/v4/accounts/acc-1/secrets_store/stores/store-1/secrets",
          "POST /client/v4/accounts/acc-1/secrets_store/stores/store-1/secrets",
          "DELETE /client/v4/accounts/acc-1/tokens/tok-orphan",
        ]);
      },
    );
  });

  it("read checks both token and secret, returns SecretId + normalized params, and handles missing token/secret", async () => {
    const { token } = makeToken();

    // 1. Both token and secret exist
    mockFetch((call) => {
      if (call.url.endsWith("/accounts/acc-1/tokens/tok-1")) {
        return ok({
          id: "tok-1",
          name: "shop--dev--deploy-bot",
          policies: [
            {
              id: "pol-1",
              effect: "allow",
              permission_groups: [
                { id: "pg-workers", name: "Workers Scripts Write" },
              ],
              resources: { "com.cloudflare.api.account.acc-1": "*" },
            },
          ],
          expires_on: "2028-01-01T00:00:00.000Z",
        });
      }
      if (call.url.includes("/secrets_store/stores/store-1/secrets")) {
        return ok([{ id: "sec-tok-1", name: "shop--dev--deploy-bot" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    expect(
      await token.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        TokenId: "tok-1",
      }),
    ).toEqual({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--deploy-bot",
      TokenId: "tok-1",
      SecretId: "sec-tok-1",
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-workers" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
      Condition: {},
      ExpiresOn: "2028-01-01T00:00:00Z",
    });

    // 2. Token missing -> ResourceNotFoundError
    mockFetch((call) => {
      if (call.url.endsWith("/accounts/acc-1/tokens/tok-1")) {
        return fail(404, 1003, "token not found");
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });
    await expect(
      token.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        TokenId: "tok-1",
      }),
    ).rejects.toThrow(ResourceNotFoundError);

    // 3. Token exists, secret missing -> clear rotation guidance
    mockFetch((call) => {
      if (call.url.endsWith("/accounts/acc-1/tokens/tok-1")) {
        return ok({
          id: "tok-1",
          name: "shop--dev--deploy-bot",
          policies: [],
        });
      }
      if (call.url.includes("/secrets")) {
        return ok([]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });
    await expect(
      token.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        TokenId: "tok-1",
      }),
    ).rejects.toThrow(
      /The secret "shop--dev--deploy-bot" for API token "token:deploy-bot".*Rotate the token by changing its id/,
    );
  });

  it("rejects replacement when AccountId changes", () => {
    const { token } = makeToken();
    const { AccountId } = token.schema;
    if (AccountId.propertyType !== "param") throw new Error("not a param");

    expect(AccountId.rejectReplace?.("old-acc", "new-acc")).toMatch(
      /CLOUDFLARE_ACCOUNT_ID is new-acc, but this API token was created in the account old-acc/,
    );
  });

  it("update sends PUT to token endpoint and delete removes both token and secret", async () => {
    const { token } = makeToken();

    mockFetch((call) => {
      if (
        call.method === "PUT" &&
        call.url.endsWith("/accounts/acc-1/tokens/tok-1")
      ) {
        return ok({ id: "tok-1" });
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith("/accounts/acc-1/tokens/tok-1")
      ) {
        return ok({ id: "tok-1" });
      }
      if (
        call.method === "DELETE" &&
        call.url.endsWith("/secrets_store/stores/store-1/secrets/sec-tok-1")
      ) {
        return ok({ id: "sec-tok-1" });
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await token.update!(
      {
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        TokenId: "tok-1",
      },
      { Policies: [] } as any,
      {
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        Policies: [
          {
            effect: "allow",
            permission_groups: [{ id: "pg-workers" }],
            resources: { "com.cloudflare.api.account.acc-1": "*" },
          },
        ],
      },
      {} as any,
    );

    await token.delete(
      {
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--deploy-bot",
        TokenId: "tok-1",
      },
      { SecretId: "sec-tok-1" } as any,
    );

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PUT /client/v4/accounts/acc-1/tokens/tok-1",
      "DELETE /client/v4/accounts/acc-1/tokens/tok-1",
      "DELETE /client/v4/accounts/acc-1/secrets_store/stores/store-1/secrets/sec-tok-1",
    ]);
  });

  it("drift detection reports noop on reordered remote policies and drift-update when changed", async () => {
    const { token } = makeToken({
      Policies: [
        {
          effect: "allow",
          permission_groups: [{ id: "pg-b" }, { id: "pg-a" }],
          resources: { "com.cloudflare.api.account.acc-1": "*" },
        },
      ],
    });
    const desiredParams = await token.getParams();
    const persistedOutput = {
      ...desiredParams,
      TokenId: "tok-1",
      SecretId: "sec-tok-1",
    };
    token.setOutput(persistedOutput as any);

    // Remote returns permission groups reversed -> still noop
    mockFetch((call) => {
      if (call.url.endsWith("/accounts/acc-1/tokens/tok-1")) {
        return ok({
          id: "tok-1",
          name: "shop--dev--deploy-bot",
          policies: [
            {
              effect: "allow",
              permission_groups: [{ id: "pg-a" }, { id: "pg-b" }],
              resources: { "com.cloudflare.api.account.acc-1": "*" },
            },
          ],
        });
      }
      if (call.url.includes("/secrets")) {
        return ok([{ id: "sec-tok-1", name: "shop--dev--deploy-bot" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const noopAction = await runOperation(
      applyDriftDetection(createStepRunner(), {
        action: { decision: "noop" },
        driftDetection: true,
        resource: token,
        resourceParams: desiredParams,
        persistedOutput,
        emit: toEmitStep(undefined),
      }),
    );
    expect(noopAction.decision).toBe("noop");

    // Remote has an extra condition -> drift-update
    mockFetch((call) => {
      if (call.url.endsWith("/accounts/acc-1/tokens/tok-1")) {
        return ok({
          id: "tok-1",
          name: "shop--dev--deploy-bot",
          policies: [
            {
              effect: "allow",
              permission_groups: [{ id: "pg-a" }, { id: "pg-b" }],
              resources: { "com.cloudflare.api.account.acc-1": "*" },
            },
          ],
          condition: { request_ip: { in: ["1.2.3.4/32"] } },
        });
      }
      if (call.url.includes("/secrets")) {
        return ok([{ id: "sec-tok-1", name: "shop--dev--deploy-bot" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const driftedAction = await runOperation(
      applyDriftDetection(createStepRunner(), {
        action: { decision: "noop" },
        driftDetection: true,
        resource: token,
        resourceParams: desiredParams,
        persistedOutput,
        emit: toEmitStep(undefined),
      }),
    );
    expect(driftedAction.decision).toBe("drift-update");
  });
});
