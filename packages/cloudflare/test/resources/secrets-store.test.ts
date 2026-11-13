import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSecretTargets,
  Redacted,
  registerSecretTarget,
  runWithExecutionContext,
  runWithSecretPromptHandler,
  runWithSecretValues,
  scrubError,
} from "@notation/core";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  UNKNOWN_AFTER_APPLY,
} from "@notation/resource";
import { sources } from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import { SecretsStore } from "src/resources/secrets-store/secrets-store";
import { SecretsStoreSecret } from "src/resources/secrets-store/secrets-store-secret";

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
  clearSecretTargets();
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc-1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSecretTargets();
});

describe("SecretsStore resource", () => {
  it("adopts an existing store on create without POSTing", async () => {
    mockFetch((call) => {
      if (
        call.method === "GET" &&
        call.url.includes("/accounts/acc-1/secrets_store/stores")
      ) {
        return ok([{ id: "store-existing", name: "my_store" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const store = new SecretsStore("secrets-store");
    const created = await store.create({ AccountId: "acc-1" });
    expect(created).toEqual({ StoreId: "store-existing" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });

  it("creates default_secrets_store when none exists", async () => {
    mockFetch((call) => {
      if (call.method === "GET") return ok([]);
      if (call.method === "POST") {
        expect(call.body).toEqual({ name: "default_secrets_store" });
        return ok({ id: "store-new", name: "default_secrets_store" });
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const store = new SecretsStore("secrets-store");
    const created = await store.create({ AccountId: "acc-1" });
    expect(created).toEqual({ StoreId: "store-new" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("recovers from a concurrent create race by listing again and adopting the winner", async () => {
    let getCount = 0;
    mockFetch((call) => {
      if (call.method === "GET") {
        getCount += 1;
        return ok(
          getCount === 1
            ? []
            : [{ id: "store-winner", name: "default_secrets_store" }],
        );
      }
      if (call.method === "POST") {
        return fail(409, 1000, "store already exists");
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    const store = new SecretsStore("secrets-store");
    const created = await store.create({ AccountId: "acc-1" });
    expect(created).toEqual({ StoreId: "store-winner" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("rethrows 5xx errors on create without swallowing them", async () => {
    mockFetch((call) => {
      if (call.method === "GET") return ok([]);
      return fail(500, 1000, "internal error");
    });

    const store = new SecretsStore("secrets-store");
    await expect(store.create({ AccountId: "acc-1" })).rejects.toThrow(
      ResourceCreationUnknownError,
    );
  });

  it("find returns the account store or throws ResourceNotFoundError", async () => {
    mockFetch(() => ok([]));
    const store = new SecretsStore("secrets-store");
    await expect(store.find!({ AccountId: "acc-1" }, "t1")).rejects.toThrow(
      ResourceNotFoundError,
    );

    mockFetch(() => ok([{ id: "store-1", name: "default_secrets_store" }]));
    await expect(store.find!({ AccountId: "acc-1" }, "t2")).resolves.toEqual({
      StoreId: "store-1",
    });
  });

  it("read returns key when store exists and throws ResourceNotFoundError when gone", async () => {
    mockFetch(() => ok({ id: "store-1", name: "default_secrets_store" }));
    const store = new SecretsStore("secrets-store");
    await expect(
      store.read!({ AccountId: "acc-1", StoreId: "store-1" }),
    ).resolves.toEqual({ AccountId: "acc-1", StoreId: "store-1" });

    mockFetch(() => fail(404, 1001, "store not found"));
    await expect(
      store.read!({ AccountId: "acc-1", StoreId: "store-1" }),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  it("delete is a no-op because the store is account-wide", async () => {
    mockFetch(() => {
      throw new Error("Should not call Cloudflare on SecretsStore.delete");
    });
    const store = new SecretsStore("secrets-store");
    await expect(
      store.delete({ AccountId: "acc-1", StoreId: "store-1" }, {} as any),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("SecretsStoreSecret resource", () => {
  function makeSecret(opts?: {
    id?: string;
    name?: string;
    source?: Source;
    key?: string;
    storeId?: string;
    version?: string;
  }) {
    const id = opts?.id ?? "stripe-key";
    const name = opts?.name ?? `shop--dev--${id}`;
    const store = new SecretsStore("secrets-store");
    store.setOutput({
      AccountId: "acc-1",
      StoreId: opts?.storeId ?? "store-1",
    } as any);

    const value =
      opts?.source && opts?.key
        ? new sources.SourceValue(`value:${id}`, {
            config: { Source: opts.source.name, Key: opts.key },
            source: opts.source,
          })
        : undefined;
    if (value && opts?.source && opts?.key) {
      value.setOutput({
        Source: opts.source.name,
        Key: opts.key,
        ...(opts.version ? { Version: opts.version } : {}),
      } as any);
    }

    const secret = new SecretsStoreSecret(`secret:${id}`, {
      config: { Name: name },
      dependencies: { store, ...(value ? { value } : {}) },
    });

    registerSecretTarget({
      id,
      resource: secret,
      source: opts?.source,
      key: opts?.key,
    });

    return { store, value, secret };
  }

  it("deriveParams produces ValueFrom with Source/Key/Version or { Source: 'prompt' }", async () => {
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("val"),
      version: async () => "v2",
    };

    const sourced = makeSecret({
      source: vault,
      key: "STRIPE_KEY",
      version: "v2",
    });
    expect(await sourced.secret.getParams()).toEqual({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--stripe-key",
      ValueFrom: { Source: "vault", Key: "STRIPE_KEY", Version: "v2" },
    });

    clearSecretTargets();
    const prompt = makeSecret();
    expect(await prompt.secret.getParams()).toEqual({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--stripe-key",
      ValueFrom: { Source: "prompt" },
    });
  });

  it("create with source fetches via getValue, writes with scopes ['workers'], records secret, and returns no value", async () => {
    const SENTINEL = "sk_live_SUPER_SECRET_SENTINEL_1";
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted(SENTINEL),
    };
    const { secret } = makeSecret({ source: vault, key: "STRIPE_KEY" });

    mockFetch((call) => {
      if (call.method === "GET") return ok([]);
      if (call.method === "POST") {
        expect(call.url).toContain(
          "/accounts/acc-1/secrets_store/stores/store-1/secrets",
        );
        expect(call.body).toEqual([
          {
            name: "shop--dev--stripe-key",
            value: SENTINEL,
            scopes: ["workers"],
          },
        ]);
        return ok([{ id: "sec-1", name: "shop--dev--stripe-key" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await runWithExecutionContext(
      { stage: "dev", executionId: "e1" },
      async () => {
        const result = await secret.create({
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "vault", Key: "STRIPE_KEY" },
        });
        expect(result).toBeUndefined();

        // Simulate Cloudflare echoing the secret value in an error: scrubError redacts it.
        const leaked = new Error(`invalid value: ${SENTINEL}`);
        expect(scrubError(leaked)).toMatchObject({
          message: expect.not.stringContaining(SENTINEL),
        });
        expect((scrubError(leaked) as Error).message).toContain("[REDACTED]");
      },
    );
  });

  it("create with prompt adopts an existing secret in the store without prompting", async () => {
    const { secret } = makeSecret({ name: "SHARED_KEY" });
    const promptSpy = vi.fn(async () => new Redacted("should-not-be-called"));

    mockFetch((call) => {
      if (call.method === "GET") {
        return ok([{ id: "sec-existing", name: "SHARED_KEY" }]);
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
      runWithSecretPromptHandler(promptSpy, () =>
        secret.create({
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "SHARED_KEY",
          ValueFrom: { Source: "prompt" },
        }),
      ),
    );

    expect(promptSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });

  it("create with prompt and preset value overwrites an existing secret via PATCH without scopes", async () => {
    const SENTINEL = "preset_SECRET_SENTINEL_2";
    const { secret } = makeSecret();

    mockFetch((call) => {
      if (call.method === "GET") {
        return ok([{ id: "sec-1", name: "shop--dev--stripe-key" }]);
      }
      if (call.method === "PATCH") {
        expect(call.url).toContain(
          "/accounts/acc-1/secrets_store/stores/store-1/secrets/sec-1",
        );
        expect(call.body).toEqual({ value: SENTINEL });
        return ok({ id: "sec-1", name: "shop--dev--stripe-key" });
      }
      throw new Error(`Unexpected ${call.method} ${call.url}`);
    });

    await runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
      runWithSecretValues({ "stripe-key": new Redacted(SENTINEL) }, () =>
        secret.create({
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        }),
      ),
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
  });

  it("create with prompt prompts when missing, or fails cleanly without a handler/TTY", async () => {
    const SENTINEL = "prompted_SECRET_SENTINEL_3";
    const { secret } = makeSecret();

    mockFetch((call) => {
      if (call.method === "GET") return ok([]);
      if (call.method === "POST") {
        expect(call.body).toEqual([
          {
            name: "shop--dev--stripe-key",
            value: SENTINEL,
            scopes: ["workers"],
          },
        ]);
        return ok([{ id: "sec-2", name: "shop--dev--stripe-key" }]);
      }
      throw new Error(`Unexpected ${call.method}`);
    });

    // Missing without prompt handler or TTY throws
    await expect(
      runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
        secret.create({
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        }),
      ),
    ).rejects.toThrow(/notation secret set/);

    // With prompt handler it writes the prompted secret
    calls = [];
    await runWithExecutionContext({ stage: "dev", executionId: "e2" }, () =>
      runWithSecretPromptHandler(
        async () => new Redacted(SENTINEL),
        () =>
          secret.create({
            AccountId: "acc-1",
            StoreId: "store-1",
            Name: "shop--dev--stripe-key",
            ValueFrom: { Source: "prompt" },
          }),
      ),
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("create throws ResourceCreationUnknownError if Cloudflare returns empty result", async () => {
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("val"),
    };
    const { secret } = makeSecret({ source: vault, key: "K" });
    mockFetch((call) => (call.method === "GET" ? ok([]) : ok([])));

    await runWithExecutionContext(
      { stage: "dev", executionId: "e1" },
      async () => {
        await expect(
          secret.create({
            AccountId: "acc-1",
            StoreId: "store-1",
            Name: "shop--dev--stripe-key",
            ValueFrom: { Source: "vault", Key: "K" },
          }),
        ).rejects.toThrow(ResourceCreationUnknownError);
      },
    );
  });

  it("read searches across pages and returns SecretId, or throws ResourceNotFoundError", async () => {
    const { secret } = makeSecret();
    mockFetch((call) => {
      if (call.url.includes("page=2")) {
        return ok([{ id: "sec-page2", name: "shop--dev--stripe-key" }], {
          page: 2,
          total_pages: 2,
        });
      }
      return ok([{ id: "sec-other", name: "other" }], {
        page: 1,
        total_pages: 2,
      });
    });

    await expect(
      secret.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--stripe-key",
      }),
    ).resolves.toEqual({
      AccountId: "acc-1",
      StoreId: "store-1",
      Name: "shop--dev--stripe-key",
      SecretId: "sec-page2",
    });

    mockFetch(() => ok([]));
    await expect(
      secret.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--stripe-key",
      }),
    ).rejects.toThrow(ResourceNotFoundError);

    mockFetch(() => fail(404, 1001, "store not found"));
    await expect(
      secret.read!({
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--stripe-key",
      }),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  it("update patches secret value using state SecretId without sending scopes", async () => {
    const SENTINEL = "updated_SECRET_SENTINEL_4";
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted(SENTINEL),
    };
    const { secret } = makeSecret({ source: vault, key: "K" });

    mockFetch((call) => {
      if (call.method === "PATCH") {
        expect(call.url).toContain("/secrets/sec-existing");
        expect(call.body).toEqual({ value: SENTINEL });
        return ok({ id: "sec-existing", name: "shop--dev--stripe-key" });
      }
      throw new Error(`Unexpected ${call.method}`);
    });

    await runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
      secret.update!(
        {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
        },
        { ValueFrom: { Source: "vault", Key: "K", Version: "v2" } } as any,
        {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "vault", Key: "K", Version: "v2" },
        },
        { SecretId: "sec-existing" } as any,
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
  });

  it("delete removes stage-scoped secrets, ignores already-gone, and skips Adopted secrets even when name contains --", async () => {
    const { secret } = makeSecret();
    mockFetch((call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/secrets/sec-1");
      return ok({ id: "sec-1" });
    });

    await secret.delete(
      {
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--stripe-key",
      },
      { SecretId: "sec-1" } as any,
    );
    expect(calls).toHaveLength(1);

    // Already gone (404) succeeds silently
    mockFetch(() => fail(404, 1003, "secret not found"));
    await expect(
      secret.delete(
        {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
        },
        { SecretId: "sec-1" } as any,
      ),
    ).resolves.toBeUndefined();

    // Adopted secrets are NOT deleted in Cloudflare, even when Name contains `--`
    calls = [];
    mockFetch(() => {
      throw new Error("Must not delete Adopted secret");
    });
    await secret.delete(
      { AccountId: "acc-1", StoreId: "store-1", Name: "org--shared--key" },
      { SecretId: "sec-explicit", Adopted: true } as any,
    );
    expect(calls).toHaveLength(0);
  });

  it("planNotes warns on unset prompt secrets during create/replace/drift-recreate and stays silent when set or sourced", async () => {
    const { secret: promptSecret } = makeSecret();
    const noteText = "not set; deploy will ask for it, or fail without a TTY";

    // Undeployed store (StoreId is UNKNOWN_AFTER_APPLY)
    expect(
      await promptSecret.planNotes!({
        decision: "create",
        params: {
          AccountId: "acc-1",
          StoreId: UNKNOWN_AFTER_APPLY,
          Name: "shop--dev--stripe-key",
          ValueFrom: UNKNOWN_AFTER_APPLY,
        },
      }),
    ).toEqual([noteText]);

    // Store exists, secret missing in store (create and replace)
    mockFetch(() => ok([]));
    expect(
      await promptSecret.planNotes!({
        decision: "create",
        params: {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        },
      }),
    ).toEqual([noteText]);
    expect(
      await promptSecret.planNotes!({
        decision: "replace",
        params: {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        },
      }),
    ).toEqual([noteText]);

    // Store exists, secret already set in store -> silent
    mockFetch(() => ok([{ id: "sec-1", name: "shop--dev--stripe-key" }]));
    expect(
      await promptSecret.planNotes!({
        decision: "drift-recreate",
        params: {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        },
      }),
    ).toBeUndefined();

    // Update when prompt -> warns that deploy will ask for a value
    expect(
      await promptSecret.planNotes!({
        decision: "update",
        params: {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        },
      }),
    ).toEqual(["deploy will ask for a value, or fail without a TTY"]);

    // Noop decisions -> silent
    expect(
      await promptSecret.planNotes!({
        decision: "noop",
        params: {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "prompt" },
        },
      }),
    ).toBeUndefined();

    // Sourced secret -> silent even when StoreId is unknown
    clearSecretTargets();
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("val"),
    };
    const { secret: sourcedSecret } = makeSecret({ source: vault, key: "K" });
    expect(
      await sourcedSecret.planNotes!({
        decision: "create",
        params: {
          AccountId: "acc-1",
          StoreId: UNKNOWN_AFTER_APPLY,
          Name: "shop--dev--stripe-key",
          ValueFrom: UNKNOWN_AFTER_APPLY,
        },
      }),
    ).toBeUndefined();
  });

  it("update recovers from a stale SecretId (404 secret_not_found) by looking up or recreating", async () => {
    const vault: Source = {
      name: "vault",
      has: async () => true,
      get: async () => new Redacted("new-val"),
    };
    const { secret } = makeSecret({ source: vault, key: "K" });

    // Stale SecretId 404s on PATCH, findSecretByName misses -> POST creates new secret
    mockFetch((call) => {
      if (call.method === "PATCH") {
        return fail(400, 1001, "secret_not_found");
      }
      if (call.method === "GET") {
        return ok([]);
      }
      if (call.method === "POST") {
        return ok([{ id: "sec-new", name: "shop--dev--stripe-key" }]);
      }
      throw new Error(`Unexpected ${call.method}`);
    });

    await runWithExecutionContext({ stage: "dev", executionId: "e2" }, () =>
      secret.update!(
        {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
        },
        { ValueFrom: { Source: "vault", Key: "K", Version: "v2" } } as any,
        {
          AccountId: "acc-1",
          StoreId: "store-1",
          Name: "shop--dev--stripe-key",
          ValueFrom: { Source: "vault", Key: "K", Version: "v2" },
        },
        { SecretId: "sec-stale" } as any,
      ),
    );
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET", "POST"]);
  });

  it("delete still removes the old stage-scoped secret when replacing into Adopted: true", async () => {
    const { secret } = makeSecret({ name: "explicit-adopted" });
    mockFetch((call) => {
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/secrets/sec-old");
      return ok({ id: "sec-old" });
    });

    // State has no Adopted flag (old stage-scoped secret), even though new config has Adopted: true
    await secret.delete(
      {
        AccountId: "acc-1",
        StoreId: "store-1",
        Name: "shop--dev--stripe-key",
      },
      { SecretId: "sec-old" } as any,
    );
    expect(calls).toHaveLength(1);
  });
});
