import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithSecretContext } from "@notation/core";
import { infisical, InfisicalApiError } from "src/sources";

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

const secret = (secretKey: string, secretValue: string, version = 1) => ({
  id: `id-${secretKey}`,
  version,
  type: "shared" as "shared" | "personal",
  secretKey,
  secretValue,
  secretValueHidden: false,
});

const folder = (...secrets: ReturnType<typeof secret>[]) =>
  Response.json({ secrets, imports: [] });

const loginResponse = (accessToken: string) =>
  Response.json({
    accessToken,
    expiresIn: 7200,
    accessTokenMaxTTL: 7200,
    tokenType: "Bearer",
  });

let runs = 0;
function inRun<T>(fn: () => Promise<T>, stage = "dev"): Promise<T> {
  return runWithSecretContext({ stage, runId: `run-${++runs}` }, fn);
}

const context = { stage: "dev" };

beforeEach(() => {
  calls = [];
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

describe("infisical", () => {
  it("lists one folder and answers has, version and get from it", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    mockFetch(() => folder(secret("STRIPE_KEY", "sk_live_1", 14)));
    const source = infisical({
      projectId: "proj",
      environment: "dev",
      path: "/orders",
    });

    await inRun(async () => {
      expect(source.name).toBe("infisical");
      await expect(source.has("STRIPE_KEY", context)).resolves.toBe(true);
      await expect(source.has("MISSING", context)).resolves.toBe(false);
      await expect(source.version!("STRIPE_KEY", context)).resolves.toBe(
        "id-STRIPE_KEY:14",
      );
      expect((await source.get("STRIPE_KEY", context)).unwrap()).toBe(
        "sk_live_1",
      );
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe("GET");
    expect(call!.url.origin).toBe("https://app.infisical.com");
    expect(call!.url.pathname).toBe("/api/v4/secrets");
    expect(Object.fromEntries(call!.url.searchParams)).toEqual({
      projectId: "proj",
      environment: "dev",
      secretPath: "/orders",
      viewSecretValue: "true",
      expandSecretReferences: "true",
      includeImports: "false",
      includePersonalOverrides: "false",
      recursive: "false",
    });
    expect(call!.headers.get("authorization")).toBe("Bearer st.token");
  });

  it("fetches the folder again in a new run, which calls infisical() again", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    let version = 1;
    mockFetch(() => folder(secret("STRIPE_KEY", "sk", version)));
    const source = () => infisical({ projectId: "proj", environment: "dev" });

    await expect(
      inRun(() => source().version!("STRIPE_KEY", context)),
    ).resolves.toBe("id-STRIPE_KEY:1");
    version = 2;
    await expect(
      inRun(() => source().version!("STRIPE_KEY", context)),
    ).resolves.toBe("id-STRIPE_KEY:2");
    expect(calls).toHaveLength(2);
  });

  it("takes the environment from a function of the stage", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    mockFetch(() => folder());
    const source = infisical({
      projectId: "proj",
      environment: (stage) => (stage === "prod" ? "prod" : "dev"),
      path: "orders/",
    });

    await inRun(async () => {
      await source.has("A", { stage: "prod" });
      await source.has("A", { stage: "pr-12" });
    });

    expect(calls.map((c) => c.url.searchParams.get("environment"))).toEqual([
      "prod",
      "dev",
    ]);
    expect(calls[0]!.url.searchParams.get("secretPath")).toBe("/orders");
  });

  it("ignores a personal override, and reads the shared secret", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    mockFetch(() =>
      folder(
        secret("STRIPE_KEY", "sk_shared"),
        { ...secret("STRIPE_KEY", "sk_personal"), type: "personal" },
        { ...secret("MINE", "personal_only"), type: "personal" },
      ),
    );
    const source = infisical({ projectId: "proj", environment: "dev" });

    await inRun(async () => {
      expect((await source.get("STRIPE_KEY", context)).unwrap()).toBe(
        "sk_shared",
      );
      await expect(source.has("MINE", context)).resolves.toBe(false);
    });
  });

  it("names the folder when a key is missing", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    mockFetch(() => folder());
    const source = infisical({
      projectId: "proj",
      environment: "dev",
      path: "/orders",
    });

    await expect(
      inRun(() => source.get("STRIPE_KEY", context)),
    ).rejects.toThrow(
      "`STRIPE_KEY` isn't in Infisical project proj, environment dev, path /orders.",
    );
  });

  it("fails when the identity can't read values", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    mockFetch(() =>
      folder({
        ...secret("STRIPE_KEY", "<hidden-by-infisical>"),
        secretValueHidden: true,
      }),
    );
    const source = infisical({ projectId: "proj", environment: "dev" });

    await inRun(async () => {
      await expect(source.has("STRIPE_KEY", context)).rejects.toThrow(
        "can't read the value of `STRIPE_KEY` in Infisical project proj, environment dev, path /. Give it a role that can read secret values.",
      );
      await expect(source.get("STRIPE_KEY", context)).rejects.toThrow(
        "can't read the value of `STRIPE_KEY`",
      );
    });
  });

  it("uses INFISICAL_DOMAIN and drops a trailing /api", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    vi.stubEnv("INFISICAL_DOMAIN", "https://vault.example.com/api/");
    mockFetch(() => folder());

    await inRun(() =>
      infisical({ projectId: "proj", environment: "dev" }).has("A", context),
    );

    expect(calls[0]!.url.href).toMatch(
      /^https:\/\/vault\.example\.com\/api\/v4\/secrets\?/,
    );
  });

  it("keeps the path prefix of a site URL", async () => {
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockFetch((call) =>
      call.method === "POST" ? loginResponse("ua.token") : folder(),
    );
    const source = infisical({
      projectId: "proj",
      environment: "dev",
      siteUrl: "https://example.com/infisical/",
    });

    await inRun(() => source.has("A", context));

    expect(
      calls.map((c) => `${c.method} ${c.url.origin}${c.url.pathname}`),
    ).toEqual([
      "POST https://example.com/infisical/api/v1/auth/universal-auth/login",
      "GET https://example.com/infisical/api/v4/secrets",
    ]);
  });

  it("reports the API's error message, and tries again on the next call", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    let status = 403;
    mockFetch(() =>
      status === 403
        ? Response.json(
            {
              reqId: "r",
              statusCode: 403,
              message: "You are not allowed to read secrets",
              error: "PermissionDenied",
            },
            { status },
          )
        : folder(secret("A", "a")),
    );
    const source = infisical({ projectId: "proj", environment: "dev" });

    await inRun(async () => {
      const error = await source.has("A", context).catch((e) => e);
      expect(error).toBeInstanceOf(InfisicalApiError);
      expect(error.message).toBe(
        "Infisical API GET /api/v4/secrets failed with status 403: You are not allowed to read secrets",
      );
      status = 200;
      await expect(source.has("A", context)).resolves.toBe(true);
    });
  });
});

describe("authentication", () => {
  const source = () => infisical({ projectId: "proj", environment: "dev" });

  it("logs in with a machine identity's client ID and secret, once per source", async () => {
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockFetch((call) =>
      call.url.pathname === "/api/v1/auth/universal-auth/login"
        ? loginResponse("ua.token")
        : folder(),
    );
    const byStage = infisical({ projectId: "proj", environment: (s) => s });

    await byStage.has("A", { stage: "dev" });
    await byStage.has("A", { stage: "prod" });

    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/auth/universal-auth/login",
      "GET /api/v4/secrets",
      "GET /api/v4/secrets",
    ]);
    expect(calls[0]!.body).toEqual({
      clientId: "client",
      clientSecret: "secret",
    });
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer ua.token");
  });

  it("prefers INFISICAL_TOKEN", async () => {
    vi.stubEnv("INFISICAL_TOKEN", "st.token");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockFetch(() => folder());

    await inRun(() => source().has("A", context));

    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v4/secrets"]);
  });

  it("fails when only one of the client ID and secret is set", async () => {
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client");
    mockFetch(() => folder());

    await expect(inRun(() => source().has("A", context))).rejects.toThrow(
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
    mockFetch((call) => {
      if (call.url.host === "token.actions.example") {
        return Response.json({ value: "github.jwt" });
      }
      if (call.url.pathname === "/api/v1/auth/oidc-auth/login") {
        return loginResponse("oidc.token");
      }
      return folder();
    });

    await inRun(() => source().has("A", context));

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
    expect(calls[2]!.headers.get("authorization")).toBe("Bearer oidc.token");
  });

  it("logs in with OIDC using INFISICAL_JWT", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity");
    vi.stubEnv("INFISICAL_JWT", "gitlab.jwt");
    mockFetch((call) =>
      call.url.pathname === "/api/v1/auth/oidc-auth/login"
        ? loginResponse("oidc.token")
        : folder(),
    );

    await inRun(() => source().has("A", context));

    expect(calls[0]!.body).toEqual({
      identityId: "identity",
      jwt: "gitlab.jwt",
    });
  });

  it("explains how to get an OIDC token when there is none", async () => {
    vi.stubEnv("INFISICAL_IDENTITY_ID", "identity");
    mockFetch(() => folder());

    await expect(inRun(() => source().has("A", context))).rejects.toThrow(
      "give the job the permission `id-token: write`",
    );
  });

  it("lists the credentials it reads when none are set", async () => {
    mockFetch(() => folder());

    await expect(inRun(() => source().has("A", context))).rejects.toThrow(
      "Set INFISICAL_TOKEN, or INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, or INFISICAL_IDENTITY_ID in CI",
    );
  });
});
