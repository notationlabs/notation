import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectResourceGraph,
  isResourceClass,
  type BaseCredentialSource,
} from "@notation/resource";
import * as infisical from "src/resources";
import { InfisicalSecret, SecretReplacedError } from "src/resources";

type Call = { method: string; url: URL; headers: Headers; body: unknown };
let calls: Call[];

type Stored = { id: string; version: number; secretValue: string };

/**
 * Answers Infisical's API from `secrets`, keyed by secret name, with each
 * version of each secret. `expanded` gives the value of a secret with its
 * references replaced, when it differs from the stored text.
 */
function mockInfisical(
  secrets: Record<string, Stored[]>,
  expanded: Record<string, string> = {},
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(url)),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    if (call.url.pathname.endsWith("/login")) {
      return Response.json({ accessToken: "login.token", expiresIn: 7200 });
    }
    const name = decodeURIComponent(call.url.pathname.split("/").pop()!);
    const versions = secrets[name];
    const version = call.url.searchParams.get("version");
    const found = version
      ? versions?.find((s) => s.version === Number(version))
      : versions?.at(-1);
    if (!found) {
      return Response.json({ message: "Secret not found" }, { status: 404 });
    }
    const expand = call.url.searchParams.get("expandSecretReferences");
    const secretValue =
      expand === "true" && !version
        ? (expanded[name] ?? found.secretValue)
        : found.secretValue;
    return Response.json({
      secret: {
        ...found,
        secretKey: name,
        secretValue,
        type: "shared",
        secretValueHidden: false,
      },
    });
  });
}

const address = {
  projectId: "proj",
  environment: "prod",
  path: "/orders",
  key: "STRIPE_KEY",
};
const scope = { app: "shop", stage: "prod", id: "stripe-key" };
const loadContext = { ...scope, executionId: "exec-1" };

async function declare(config: typeof address & { track?: "hmac" }) {
  const graph = await collectResourceGraph(() => {
    new InfisicalSecret("stripe-key", { config });
  });
  return graph.resources[0] as BaseCredentialSource;
}

async function read(
  source: BaseCredentialSource,
  params: Record<string, unknown>,
): Promise<string> {
  const result = (await source.readSource(params, {
    ...loadContext,
    state: undefined,
    warn: () => {},
  })) as { revision: string };
  return result.revision;
}

beforeEach(() => {
  calls = [];
  for (const name of [
    "INFISICAL_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
    "INFISICAL_IDENTITY_ID",
    "INFISICAL_DOMAIN",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("INFISICAL_TOKEN", "st.token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("InfisicalSecret", () => {
  it("exports classes that name @notation/infisical/resources as their provider", () => {
    const classes = (Object.values(infisical) as unknown[]).filter(
      isResourceClass,
    );
    expect(classes).toContain(InfisicalSecret);
    for (const Resource of classes) {
      expect(Resource.provider).toBe("@notation/infisical/resources");
    }
  });

  it("has the secret's ID and version as its revision, and loads that version", async () => {
    mockInfisical({
      STRIPE_KEY: [
        { id: "sec-1", version: 14, secretValue: "sk_live_14" },
        { id: "sec-1", version: 15, secretValue: "sk_live_15" },
      ],
    });
    const source = await declare(address);

    const revision = await read(source, address);
    expect(revision).toBe("version:sec-1:15");
    expect(calls).toHaveLength(2);
    const [stored, expanded] = calls;
    expect(stored!.url.origin).toBe("https://app.infisical.com");
    expect(stored!.url.pathname).toBe("/api/v4/secrets/STRIPE_KEY");
    expect(Object.fromEntries(stored!.url.searchParams)).toEqual({
      projectId: "proj",
      environment: "prod",
      secretPath: "/orders",
      type: "shared",
      viewSecretValue: "true",
      expandSecretReferences: "false",
      includeImports: "true",
    });
    expect(expanded!.url.searchParams.get("expandSecretReferences")).toBe(
      "true",
    );
    expect(stored!.headers.get("authorization")).toBe("Bearer st.token");

    calls = [];
    await expect(
      source.loadCredential(
        { ...address, revision: "version:sec-1:14" },
        loadContext,
      ),
    ).resolves.toBe("sk_live_14");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("version")).toBe("14");
  });

  it("has the execution ID as its revision when the secret refers to another, and loads the current value", async () => {
    mockInfisical(
      {
        DATABASE_URL: [
          {
            id: "sec-2",
            version: 14,
            secretValue: "postgres://app:${DB_PASSWORD}@db/orders",
          },
        ],
      },
      { DATABASE_URL: "postgres://app:hunter2@db/orders" },
    );
    const params = { ...address, key: "DATABASE_URL" };
    const source = await declare(params);

    const revision = await read(source, params);
    expect(revision).toBe("exec:exec-1");

    calls = [];
    await expect(
      source.loadCredential({ ...params, revision }, loadContext),
    ).resolves.toBe("postgres://app:hunter2@db/orders");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("version")).toBeNull();
    expect(calls[0]!.url.searchParams.get("expandSecretReferences")).toBe(
      "true",
    );
  });

  it("with track, has a hash of the expanded value as its revision", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    const secrets = {
      DATABASE_URL: [
        { id: "sec-2", version: 14, secretValue: "postgres://${DB_PASSWORD}" },
      ],
    };
    mockInfisical(secrets, { DATABASE_URL: "postgres://hunter2" });
    const params = { ...address, key: "DATABASE_URL", track: "hmac" as const };
    const source = await declare(params);

    const revision = await read(source, params);
    expect(revision).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("expandSecretReferences")).toBe(
      "true",
    );
    await expect(
      source.loadCredential({ ...params, revision }, loadContext),
    ).resolves.toBe("postgres://hunter2");

    vi.restoreAllMocks();
    mockInfisical(secrets, { DATABASE_URL: "postgres://correct-horse" });
    expect(await read(source, params)).not.toBe(revision);
    await expect(
      source.loadCredential({ ...params, revision }, loadContext),
    ).rejects.toThrow("changed after deploy read it");
  });

  it("fails with SecretReplacedError when the secret was deleted and added again", async () => {
    mockInfisical({
      STRIPE_KEY: [{ id: "sec-new", version: 1, secretValue: "sk_live_new" }],
    });
    const source = await declare(address);

    await expect(
      source.loadCredential(
        { ...address, revision: "version:sec-1:1" },
        loadContext,
      ),
    ).rejects.toThrow(SecretReplacedError);
  });

  it("fails when the version returned is not the one in the revision, as for an imported secret", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        secret: {
          id: "sec-1",
          version: 16,
          secretKey: "STRIPE_KEY",
          secretValue: "sk_live_16",
        },
      }),
    );
    const source = await declare(address);

    await expect(
      source.loadCredential(
        { ...address, revision: "version:sec-1:15" },
        loadContext,
      ),
    ).rejects.toThrow("changed after deploy read it");
  });

  it("fails before any fetch for a revision in an unknown format", async () => {
    mockInfisical({});
    const source = await declare(address);

    for (const revision of ["sec-1:15", "exec-2", "version:sec-1:x"]) {
      await expect(
        source.loadCredential({ ...address, revision }, loadContext),
      ).rejects.toThrow(
        `\`${revision}\` is not a revision of an Infisical secret.`,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("fails before any fetch when the revision does not match track", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    mockInfisical({});
    const source = await declare(address);

    await expect(
      source.loadCredential(
        { ...address, track: "hmac", revision: "version:sec-1:15" },
        loadContext,
      ),
    ).rejects.toThrow('does not match `track: "hmac"`');
    await expect(
      source.loadCredential(
        { ...address, track: "hmac", revision: "scrypt:00" },
        loadContext,
      ),
    ).rejects.toThrow('does not match `track: "hmac"`');
    await expect(
      source.loadCredential({ ...address, revision: "hmac:00" }, loadContext),
    ).rejects.toThrow("does not match `track: undefined`");
    expect(calls).toHaveLength(0);
  });

  it('with track: "hmac" and no NOTATION_TRACK_KEY, fails before any fetch', async () => {
    mockInfisical({
      STRIPE_KEY: [{ id: "sec-1", version: 1, secretValue: "sk_live_1" }],
    });
    const params = { ...address, track: "hmac" as const };
    const source = await declare(params);

    await expect(read(source, params)).rejects.toThrow("NOTATION_TRACK_KEY");
    await expect(
      source.loadCredential({ ...params, revision: "hmac:00" }, loadContext),
    ).rejects.toThrow("NOTATION_TRACK_KEY");
    expect(calls).toHaveLength(0);
  });

  it("fails to load an empty value", async () => {
    mockInfisical({
      STRIPE_KEY: [{ id: "sec-1", version: 3, secretValue: "" }],
    });
    const source = await declare(address);

    await expect(
      source.loadCredential(
        { ...address, revision: "version:sec-1:3" },
        loadContext,
      ),
    ).rejects.toThrow(
      "The value of `STRIPE_KEY` in Infisical project proj, environment prod, path /orders is empty.",
    );
  });

  it("names a secret, or a version, that Infisical does not have", async () => {
    mockInfisical({
      STRIPE_KEY: [{ id: "sec-1", version: 15, secretValue: "sk_live_15" }],
    });
    const source = await declare(address);

    await expect(read(source, { ...address, key: "MISSING" })).rejects.toThrow(
      "`MISSING` isn't in Infisical project proj, environment prod, path /orders.",
    );
    await expect(
      source.loadCredential(
        { ...address, revision: "version:sec-1:4" },
        loadContext,
      ),
    ).rejects.toThrow("Version 4 of `STRIPE_KEY` isn't in");
  });

  it("fails at read when the identity cannot read the value", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        secret: {
          id: "sec-1",
          version: 1,
          secretKey: "STRIPE_KEY",
          secretValue: "",
          secretValueHidden: true,
        },
      }),
    );
    const source = await declare(address);

    await expect(read(source, address)).rejects.toThrow(
      "The Infisical identity can't read the value of `STRIPE_KEY`",
    );
  });

  it("logs in once for the secrets of a process", async () => {
    vi.stubEnv("INFISICAL_TOKEN", undefined);
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "client-once");
    vi.stubEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET", "secret");
    mockInfisical({
      STRIPE_KEY: [{ id: "sec-1", version: 1, secretValue: "sk_live_1" }],
    });
    const source = await declare(address);

    await read(source, address);
    await read(source, address);

    const logins = calls.filter((c) => c.url.pathname.endsWith("/login"));
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({
      clientId: "client-once",
      clientSecret: "secret",
    });
    expect(
      calls
        .filter((c) => !c.url.pathname.endsWith("/login"))
        .every((c) => c.headers.get("authorization") === "Bearer login.token"),
    ).toBe(true);
  });
});
