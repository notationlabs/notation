import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redacted, runWithExecutionContext } from "@notation/core";
import { infisical } from "src/sources";
import { clearInfisicalCache } from "src/sources/infisical";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clearInfisicalEnv() {
  const keys = [
    "INFISICAL_TOKEN",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_IDENTITY_ID",
    "INFISICAL_API_URL",
    "INFISICAL_OIDC_TOKEN",
    "INFISICAL_OIDC_AUDIENCE",
    "CI_JOB_JWT_V2",
    "CI_JOB_JWT",
    "BUILDKITE_OIDC_TOKEN",
    "CIRCLE_OIDC_TOKEN",
    "CIRCLE_OIDC_TOKEN_V2",
    "BITBUCKET_STEP_OIDC_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ];
  for (const key of keys) {
    vi.stubEnv(key, undefined);
  }
}

beforeEach(() => {
  clearInfisicalEnv();
  clearInfisicalCache();
});

afterEach(() => {
  clearInfisicalCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("infisical source", () => {
  it("exposes name, has, version, and Redacted get with INFISICAL_TOKEN", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token-123");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        secrets: [
          { secretKey: "STRIPE_KEY", secretValue: "sk_live_abc", version: 14 },
          { secretKey: "EMPTY_VAL", secretValue: "", version: 1 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-1",
      environment: "prod",
      path: "/orders",
    });

    expect(vault.name).toBe("infisical");
    expect(await vault.has("STRIPE_KEY", { stage: "prod" })).toBe(true);
    expect(await vault.has("EMPTY_VAL", { stage: "prod" })).toBe(true);
    expect(await vault.has("MISSING_KEY", { stage: "prod" })).toBe(false);

    expect(await vault.version?.("STRIPE_KEY", { stage: "prod" })).toBe("14");

    const value = await vault.get("STRIPE_KEY", { stage: "prod" });
    expect(Redacted.is(value)).toBe(true);
    expect(value.unwrap()).toBe("sk_live_abc");
    expect(() => String(value)).toThrow(TypeError);

    const emptyValue = await vault.get("EMPTY_VAL", { stage: "prod" });
    expect(emptyValue.unwrap()).toBe("");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requestUrl));
    expect(url.origin).toBe("https://app.infisical.com");
    expect(url.pathname).toBe("/api/v3/secrets/raw");
    expect(url.searchParams.get("workspaceId")).toBe("proj-1");
    expect(url.searchParams.get("environment")).toBe("prod");
    expect(url.searchParams.get("secretPath")).toBe("/orders");
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("expandSecretReferences")).toBe("true");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer direct-token-123",
    );
  });

  it("throws clear errors for missing keys on version and get", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ secrets: [] })),
    );

    const vault = infisical({
      projectId: "proj-1",
      environment: "dev",
    });

    await expect(vault.version?.("NO_SUCH_KEY", { stage: "dev" })).rejects.toThrow(
      /Secret "NO_SUCH_KEY" was not found in Infisical/,
    );
    await expect(vault.get("NO_SUCH_KEY", { stage: "dev" })).rejects.toThrow(
      /Secret "NO_SUCH_KEY" was not found in Infisical/,
    );
  });

  it("supports environment as a stage mapper function and siteUrl / INFISICAL_API_URL", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token");
    vi.stubEnv("INFISICAL_API_URL", "https://infisical.internal.example/");

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const env = url.searchParams.get("environment");
      return jsonResponse({
        secrets: [
          { secretKey: "API_KEY", secretValue: `val-${env}`, version: 3 },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fromEnvUrl = infisical({
      projectId: "proj-1",
      environment: (stage) => (stage === "production" ? "prod" : stage),
    });

    expect((await fromEnvUrl.get("API_KEY", { stage: "production" })).unwrap()).toBe(
      "val-prod",
    );
    expect((await fromEnvUrl.get("API_KEY", { stage: "staging" })).unwrap()).toBe(
      "val-staging",
    );

    const firstUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(firstUrl.origin).toBe("https://infisical.internal.example");
    expect(firstUrl.searchParams.get("environment")).toBe("prod");
    expect(firstUrl.searchParams.get("secretPath")).toBe("/");

    const explicitUrl = infisical({
      projectId: "proj-1",
      environment: "dev",
      path: "/billing/",
      siteUrl: "https://eu.infisical.com/",
    });
    expect((await explicitUrl.get("API_KEY", { stage: "dev" })).unwrap()).toBe(
      "val-dev",
    );
    const thirdUrl = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(thirdUrl.origin).toBe("https://eu.infisical.com");
    expect(thirdUrl.searchParams.get("secretPath")).toBe("/billing");
  });

  it("caches folder fetches per (siteUrl, projectId, environment, path) within the process", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token");

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const env = url.searchParams.get("environment");
      const secretPath = url.searchParams.get("secretPath");
      return jsonResponse({
        secrets: [
          {
            secretKey: "A",
            secretValue: `a-${env}-${secretPath}`,
            version: 1,
          },
          {
            secretKey: "B",
            secretValue: `b-${env}-${secretPath}`,
            version: 2,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ordersVault = infisical({
      projectId: "proj-1",
      environment: (stage) => stage,
      path: "/orders",
    });

    await Promise.all([
      ordersVault.has("A", { stage: "dev" }),
      ordersVault.version?.("A", { stage: "dev" }),
      ordersVault.get("A", { stage: "dev" }),
      ordersVault.has("B", { stage: "dev" }),
      ordersVault.version?.("B", { stage: "dev" }),
      ordersVault.get("B", { stage: "dev" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Different environment triggers a new fetch
    expect((await ordersVault.get("A", { stage: "prod" })).unwrap()).toBe(
      "a-prod-/orders",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Different path triggers a new fetch
    const paymentsVault = infisical({
      projectId: "proj-1",
      environment: "dev",
      path: "/payments",
    });
    expect((await paymentsVault.get("A", { stage: "dev" })).unwrap()).toBe(
      "a-dev-/payments",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("authenticates via Universal Auth and caches the access token", async () => {
    vi.stubEnv("INFISICAL_CLIENT_ID", "client-id-1");
    vi.stubEnv("INFISICAL_CLIENT_SECRET", "client-secret-1");

    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/auth/universal-auth/login") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            clientId: "client-id-1",
            clientSecret: "client-secret-1",
          });
          return jsonResponse({
            accessToken: "ua-access-token",
            expiresIn: 3600,
          });
        }
        if (url.pathname === "/api/v3/secrets/raw") {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer ua-access-token",
          );
          const env = url.searchParams.get("environment");
          return jsonResponse({
            secrets: [
              { secretKey: "DB_PASS", secretValue: `pass-${env}`, version: 7 },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${url.toString()}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-ua",
      environment: (stage) => stage,
    });

    expect((await vault.get("DB_PASS", { stage: "dev" })).unwrap()).toBe(
      "pass-dev",
    );
    expect((await vault.get("DB_PASS", { stage: "prod" })).unwrap()).toBe(
      "pass-prod",
    );

    // 1 Universal Auth login + 2 folder fetches (dev and prod)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const loginCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/v1/auth/universal-auth/login"),
    );
    expect(loginCalls).toHaveLength(1);
  });

  it("authenticates via GitHub Actions OIDC and INFISICAL_IDENTITY_ID", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity-gh-1");
    vi.stubEnv(
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "https://token.actions.githubusercontent.com/id?api-version=2.0",
    );
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "gh-req-token");
    vi.stubEnv("INFISICAL_OIDC_AUDIENCE", "infisical");

    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === "https://token.actions.githubusercontent.com") {
          expect(url.searchParams.get("audience")).toBe("infisical");
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer gh-req-token",
          );
          return jsonResponse({ value: "gh-oidc-jwt" });
        }
        if (url.pathname === "/api/v1/auth/oidc-auth/login") {
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({
            identityId: "identity-gh-1",
            jwt: "gh-oidc-jwt",
          });
          return jsonResponse({
            accessToken: "oidc-access-token",
            expiresIn: 3600,
          });
        }
        if (url.pathname === "/api/v3/secrets/raw") {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer oidc-access-token",
          );
          return jsonResponse({
            secrets: [
              { secretKey: "DEPLOY_KEY", secretValue: "gh-secret", version: 9 },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${url.toString()}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-oidc",
      environment: "prod",
    });

    expect(await vault.version?.("DEPLOY_KEY", { stage: "prod" })).toBe("9");
    expect((await vault.get("DEPLOY_KEY", { stage: "prod" })).unwrap()).toBe(
      "gh-secret",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("authenticates via direct CI OIDC token env vars and INFISICAL_IDENTITY_ID", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity-gitlab-1");
    vi.stubEnv("CI_JOB_JWT_V2", "gitlab-oidc-jwt");

    const fetchMock = vi.fn<typeof fetch>(
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/auth/oidc-auth/login") {
          expect(JSON.parse(String(init?.body))).toEqual({
            identityId: "identity-gitlab-1",
            jwt: "gitlab-oidc-jwt",
          });
          return jsonResponse({ accessToken: "gitlab-access-token" });
        }
        if (url.pathname === "/api/v3/secrets/raw") {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer gitlab-access-token",
          );
          return jsonResponse({
            secrets: [
              { secretKey: "TOKEN", secretValue: "gl-secret", version: 4 },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${url.toString()}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-gl",
      environment: "staging",
    });

    expect((await vault.get("TOKEN", { stage: "staging" })).unwrap()).toBe(
      "gl-secret",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws clear configuration errors when auth is missing or incomplete", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-1",
      environment: "dev",
    });

    await expect(vault.has("KEY", { stage: "dev" })).rejects.toThrow(
      /INFISICAL_TOKEN.*INFISICAL_CLIENT_ID.*INFISICAL_IDENTITY_ID/,
    );

    vi.stubEnv("INFISICAL_CLIENT_ID", "only-id");
    await expect(vault.has("KEY", { stage: "dev" })).rejects.toThrow(
      /both INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET/,
    );

    vi.stubEnv("INFISICAL_CLIENT_ID", undefined);
    vi.stubEnv("INFISICAL_IDENTITY_ID", "id-without-jwt");
    await expect(vault.has("KEY", { stage: "dev" })).rejects.toThrow(
      /no CI OIDC token was found/,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache failed folder fetches", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token");

    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("upstream error", { status: 502 });
      }
      return jsonResponse({
        secrets: [{ secretKey: "RETRY_KEY", secretValue: "ok", version: 2 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-retry",
      environment: "dev",
    });

    await expect(vault.has("RETRY_KEY", { stage: "dev" })).rejects.toThrow(
      /502/,
    );
    expect(await vault.has("RETRY_KEY", { stage: "dev" })).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes multi-slash paths like '//' and '///' to '/'", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "direct-token");

    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        secrets: [{ secretKey: "K", secretValue: "v", version: 1 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (const p of ["//", "///"]) {
      clearInfisicalCache();
      const vault = infisical({
        projectId: "proj-slash",
        environment: "dev",
        path: p,
      });
      await vault.has("K", { stage: "dev" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [requestUrl] of fetchMock.mock.calls) {
      expect(new URL(String(requestUrl)).searchParams.get("secretPath")).toBe(
        "/",
      );
    }
  });

  it("handles concurrent token expiry without duplicate logins or deleting newer entries", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      vi.stubEnv("INFISICAL_CLIENT_ID", "client-race");
      vi.stubEnv("INFISICAL_CLIENT_SECRET", "secret-race");

      let loginCount = 0;
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/auth/universal-auth/login") {
          loginCount += 1;
          //expiresIn: 60s -> with 30s buffer, valid for 30s
          return jsonResponse({
            accessToken: `token-${loginCount}`,
            expiresIn: 60,
          });
        }
        if (url.pathname === "/api/v3/secrets/raw") {
          const auth = new Headers(init?.headers).get("Authorization");
          const env = url.searchParams.get("environment");
          return jsonResponse({
            secrets: [
              {
                secretKey: "KEY",
                secretValue: `${env}-${auth}`,
                version: loginCount,
              },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${url.toString()}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const vault = infisical({
        projectId: "proj-race",
        environment: (stage) => stage,
      });

      // Prime token cache (token-1, expires in 30s after buffer)
      expect((await vault.get("KEY", { stage: "s1" })).unwrap()).toBe(
        "s1-Bearer token-1",
      );
      expect(loginCount).toBe(1);

      // Advance past token expiry
      vi.advanceTimersByTime(35_000);

      // Two concurrent calls hit the expired token at the same time
      const [v2, v3] = await Promise.all([
        vault.get("KEY", { stage: "s2" }),
        vault.get("KEY", { stage: "s3" }),
      ]);
      expect(v2.unwrap()).toBe("s2-Bearer token-2");
      expect(v3.unwrap()).toBe("s3-Bearer token-2");
      expect(loginCount).toBe(2);

      // Subsequent call while token-2 is still valid reuses token-2 (was not evicted)
      expect((await vault.get("KEY", { stage: "s4" })).unwrap()).toBe(
        "s4-Bearer token-2",
      );
      expect(loginCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes folder cache by executionId and credentials", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "token-a");

    let fetchCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      fetchCount += 1;
      const auth = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        secrets: [
          {
            secretKey: "API_KEY",
            secretValue: `val-${fetchCount}-${auth}`,
            version: fetchCount,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const vault = infisical({
      projectId: "proj-scoped",
      environment: "dev",
    });

    // Within one execution context, calls share a single folder fetch
    await runWithExecutionContext({ stage: "dev", executionId: "plan-1" }, async () => {
      expect(await vault.has("API_KEY", { stage: "dev" })).toBe(true);
      expect((await vault.get("API_KEY", { stage: "dev" })).unwrap()).toBe(
        "val-1-Bearer token-a",
      );
    });
    expect(fetchCount).toBe(1);

    // Separate executionId fetches a fresh folder snapshot
    await runWithExecutionContext({ stage: "dev", executionId: "deploy-1" }, async () => {
      expect((await vault.get("API_KEY", { stage: "dev" })).unwrap()).toBe(
        "val-2-Bearer token-a",
      );
    });
    expect(fetchCount).toBe(2);

    // Different credentials in the same executionId do not collide
    vi.stubEnv("INFISICAL_TOKEN", "token-b");
    await runWithExecutionContext({ stage: "dev", executionId: "deploy-1" }, async () => {
      expect((await vault.get("API_KEY", { stage: "dev" })).unwrap()).toBe(
        "val-3-Bearer token-b",
      );
    });
    expect(fetchCount).toBe(3);
  });
});
