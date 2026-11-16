import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, siteUrl } from "src/api";
import { cachedAccessToken } from "src/auth";

type Call = { method: string; url: URL; headers: Headers; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(url)),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
}

const loginResponse = (accessToken: string) =>
  Response.json({ accessToken, expiresIn: 7200, tokenType: "Bearer" });

// Tokens are cached per site and credentials, so each test uses its own site.
let site: string;
let siteCount = 0;

beforeEach(() => {
  calls = [];
  site = `https://app${siteCount++}.infisical.com`;
  for (const name of [
    "INFISICAL_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    "INFISICAL_IDENTITY_ID",
    "INFISICAL_JWT",
    "INFISICAL_OIDC_AUDIENCE",
    "INFISICAL_DOMAIN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("siteUrl", () => {
  it("uses INFISICAL_DOMAIN and drops a trailing /api", () => {
    vi.stubEnv("INFISICAL_DOMAIN", "https://vault.example.com/api/");
    expect(siteUrl()).toBe("https://vault.example.com");
  });

  it("keeps the path prefix of a site URL", () => {
    vi.stubEnv("INFISICAL_DOMAIN", "https://example.com/infisical/");
    const url = apiUrl(siteUrl(), "/api/v4");
    expect(url.href).toBe("https://example.com/infisical/api/v4");
  });
});

describe("cachedAccessToken", () => {
  it("logs in with a machine identity's client ID and secret", async () => {
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockFetch(() => loginResponse("ua.token"));

    await expect(cachedAccessToken(site)).resolves.toBe("ua.token");

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/auth/universal-auth/login",
    ]);
    expect(calls[0]!.body).toEqual({
      clientId: "client",
      clientSecret: "secret",
    });
  });

  it("prefers INFISICAL_TOKEN", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockFetch(() => loginResponse("ua.token"));

    await expect(cachedAccessToken(site)).resolves.toBe("st.token");
    expect(calls).toHaveLength(0);
  });

  it("fails when only one of the client ID and secret is set", async () => {
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");

    await expect(cachedAccessToken(site)).rejects.toThrow(
      "Set both INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    );
  });

  it("logs in with OIDC using a token from GitHub Actions", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity");
    vi.stubEnv(
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "https://token.actions.example/id?api-version=2.0",
    );
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token");
    vi.stubEnv("INFISICAL_OIDC_AUDIENCE", "infisical");
    mockFetch((call) =>
      call.url.host === "token.actions.example"
        ? Response.json({ value: "github.jwt" })
        : loginResponse("oidc.token"),
    );

    await expect(cachedAccessToken(site)).resolves.toBe("oidc.token");

    expect(calls[0]!.headers.get("authorization")).toBe("Bearer request-token");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      "api-version": "2.0",
      audience: "infisical",
    });
    expect(calls[1]!.url.pathname).toBe("/api/v1/auth/oidc-auth/login");
    expect(calls[1]!.body).toEqual({
      identityId: "identity",
      jwt: "github.jwt",
    });
  });

  it("logs in with OIDC using INFISICAL_JWT", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity");
    vi.stubEnv("INFISICAL_JWT", "gitlab.jwt");
    mockFetch(() => loginResponse("oidc.token"));

    await cachedAccessToken(site);

    expect(calls[0]!.body).toEqual({
      identityId: "identity",
      jwt: "gitlab.jwt",
    });
  });

  it("explains how to get an OIDC token when there is none", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity");

    await expect(cachedAccessToken(site)).rejects.toThrow(
      "give the job the permission `id-token: write`",
    );
  });

  it("lists the credentials it reads when none are set", async () => {
    await expect(cachedAccessToken(site)).rejects.toThrow(
      "Set INFISICAL_TOKEN, or INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, or INFISICAL_IDENTITY_ID in CI",
    );
  });
});
