import { inspect, types } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { BaseResource } from "@notation/resource";
import {
  REDACTED_VALUE,
  Redacted,
  clearRecordedSecrets,
  clearSecretTargets,
  getExecutionContext,
  getPresetSecretValue,
  getSecretTarget,
  listSecretTargets,
  promptSecretValue,
  recordSecret,
  registerSecretTarget,
  requireExecutionContext,
  runWithExecutionContext,
  runWithSecretPromptHandler,
  runWithSecretValues,
  scrubError,
  scrubSecrets,
} from "src/secrets";

afterEach(() => {
  clearRecordedSecrets();
  clearSecretTargets();
});

describe("Redacted", () => {
  it("unwraps the underlying value explicitly", () => {
    const secret = new Redacted("top-secret-123");
    expect(secret.unwrap()).toBe("top-secret-123");
    expect(Redacted.is(secret)).toBe(true);
    expect(Redacted.is("top-secret-123")).toBe(false);
  });

  it("throws on template literals, string coercion, toString, valueOf, and JSON.stringify", () => {
    const secret = new Redacted("super-secret");

    expect(() => `Bearer ${secret as unknown as string}`).toThrow(TypeError);
    expect(() => String(secret)).toThrow(TypeError);
    expect(() => `${secret as unknown as string}` + "").toThrow(TypeError);
    expect(() => (secret as unknown as string) + "").toThrow(TypeError);
    expect(() => secret.toString()).toThrow(TypeError);
    expect(() => secret.valueOf()).toThrow(TypeError);
    expect(() => Number(secret)).toThrow(TypeError);
    expect(() => JSON.stringify(secret)).toThrow(TypeError);
    expect(() => JSON.stringify({ secret })).toThrow(TypeError);
  });

  it("prints Redacted(<hidden>) via util.inspect and does not leak private fields", () => {
    const secret = new Redacted("do-not-print-me");

    expect(inspect(secret)).toBe("Redacted(<hidden>)");
    expect(inspect({ secret })).toBe("{ secret: Redacted(<hidden>) }");
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect({ ...secret }).toEqual({});
  });
});

describe("execution context", () => {
  it("reads stage and executionId within runWithExecutionContext", async () => {
    expect(getExecutionContext()).toBeUndefined();
    expect(() => requireExecutionContext()).toThrow(/No active execution context/);

    const result = await runWithExecutionContext(
      { stage: "staging", executionId: "exec-42" },
      async () => {
        await Promise.resolve();
        expect(getExecutionContext()).toEqual({
          stage: "staging",
          executionId: "exec-42",
        });
        return requireExecutionContext();
      },
    );

    expect(result).toEqual({ stage: "staging", executionId: "exec-42" });
    expect(getExecutionContext()).toBeUndefined();
  });

  it("isolates concurrent AsyncLocalStorage contexts", async () => {
    const [a, b] = await Promise.all([
      runWithExecutionContext({ stage: "dev", executionId: "e1" }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return requireExecutionContext();
      }),
      runWithExecutionContext({ stage: "prod", executionId: "e2" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return requireExecutionContext();
      }),
    ]);

    expect(a).toEqual({ stage: "dev", executionId: "e1" });
    expect(b).toEqual({ stage: "prod", executionId: "e2" });
  });

  it("preserves outer prompt handler and secret values when runWithExecutionContext nests inside them", async () => {
    const prompted = await runWithSecretPromptHandler(
      async ({ id, stage }) => `${id}-${stage}`,
      () =>
        runWithExecutionContext({ stage: "prod", executionId: "e-nested" }, async () => {
          expect(getExecutionContext()?.stage).toBe("prod");
          return promptSecretValue({ id: "api-key", stage: "prod" });
        }),
    );
    expect(prompted.unwrap()).toBe("api-key-prod");
  });
});

describe("secret scrubbing", () => {
  it("ignores empty strings and scrubs raw, base64, and JSON-escaped forms", () => {
    recordSecret("");
    expect(scrubSecrets("hello world")).toBe("hello world");

    const secret = 'line1\n"quote"\\slash\ttab';
    recordSecret(secret);

    const b64 = Buffer.from(secret, "utf8").toString("base64");
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);

    expect(scrubSecrets(`raw: ${secret}`)).toBe(`raw: ${REDACTED_VALUE}`);
    expect(scrubSecrets(`b64: ${b64}`)).toBe(`b64: ${REDACTED_VALUE}`);
    expect(scrubSecrets(`json: ${jsonEscaped}`)).toBe(
      `json: ${REDACTED_VALUE}`,
    );
  });

  it("matches longest secret variants first so partial matches leave no remnants", () => {
    recordSecret("secret");
    recordSecret("secret-longer-value");

    expect(scrubSecrets("token=secret-longer-value and secret")).toBe(
      `token=${REDACTED_VALUE} and ${REDACTED_VALUE}`,
    );
  });

  it("scrubError preserves Error prototype, native error slot, and Error.name while scrubbing message, stack, cause, errors, and custom properties", () => {
    const secret = "sentinel-api-key-999";
    recordSecret(secret);
    recordSecret("CredentialsProviderError");

    class ProviderError extends Error {
      readonly status = 500;
      readonly body: { token: string };
      constructor(message: string, body: { token: string }, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProviderError";
        this.body = body;
      }
    }

    const credErr = new Error(`no creds for ${secret}`);
    credErr.name = "CredentialsProviderError";
    const scrubbedCred = scrubError(credErr) as Error;
    expect(scrubbedCred.name).toBe("CredentialsProviderError");
    expect(scrubbedCred.message).toBe(`no creds for ${REDACTED_VALUE}`);

    const cause = new Error(`caused by ${secret}`);
    const err = new ProviderError(
      `API rejected ${Buffer.from(secret, "utf8").toString("base64")}`,
      { token: secret },
      { cause },
    );

    const scrubbed = scrubError(err) as ProviderError;
    expect(scrubbed).toBeInstanceOf(ProviderError);
    expect(scrubbed).toBeInstanceOf(Error);
    expect(types.isNativeError(scrubbed)).toBe(true);
    expect(scrubbed.name).toBe("ProviderError");
    expect(scrubbed.message).toBe(`API rejected ${REDACTED_VALUE}`);
    expect(scrubbed.stack).not.toContain(secret);
    expect(scrubbed.body).toEqual({ token: REDACTED_VALUE });
    expect((scrubbed.cause as Error).message).toBe(
      `caused by ${REDACTED_VALUE}`,
    );
    // Original error is not mutated
    expect(err.body.token).toBe(secret);

    const agg = new AggregateError([new Error(`inner ${secret}`)], `outer ${secret}`);
    const scrubbedAgg = scrubError(agg) as AggregateError;
    expect(scrubbedAgg.message).toBe(`outer ${REDACTED_VALUE}`);
    expect((scrubbedAgg.errors[0] as Error).message).toBe(
      `inner ${REDACTED_VALUE}`,
    );
  });
});

describe("secret registry, prompt handlers, and preset overrides", () => {
  it("registers, gets, lists, and clears secret targets", () => {
    const fakeResource = { id: "secret:stripe-key" } as BaseResource;
    registerSecretTarget({
      id: "stripe-key",
      resource: fakeResource,
      key: "STRIPE_KEY",
    });
    registerSecretTarget({
      id: "deploy-token",
      resource: { id: "token:deploy-token" } as BaseResource,
      isToken: true,
    });

    expect(getSecretTarget("stripe-key")).toMatchObject({
      id: "stripe-key",
      resource: fakeResource,
      key: "STRIPE_KEY",
    });
    expect(listSecretTargets().map((t) => t.id)).toEqual([
      "stripe-key",
      "deploy-token",
    ]);

    clearSecretTargets();
    expect(listSecretTargets()).toEqual([]);
    expect(getSecretTarget("stripe-key")).toBeUndefined();
  });

  it("throws CLI instructions when promptSecretValue is called without a handler", async () => {
    await expect(
      promptSecretValue({ id: "stripe-key", stage: "dev" }),
    ).rejects.toThrow(
      "Secret stripe-key isn't set for stage dev. Run notation secret set stripe-key --stage dev.",
    );
  });

  it("supports scoped prompt handlers (including undefined override) and records prompted values", async () => {
    const fromScoped = await runWithSecretPromptHandler(
      async ({ id }) => new Redacted(`scoped-${id}`),
      () => promptSecretValue({ id: "api-key", stage: "prod" }),
    );
    expect(fromScoped.unwrap()).toBe("scoped-api-key");
    expect(scrubSecrets("leaked scoped-api-key")).toBe(
      `leaked ${REDACTED_VALUE}`,
    );

    // Scoped undefined explicitly disables outer handler (e.g. for --json mode)
    await expect(
      runWithSecretPromptHandler(
        async ({ id }) => `outer-${id}`,
        () =>
          runWithSecretPromptHandler(undefined, () =>
            promptSecretValue({ id: "api-key", stage: "prod" }),
          ),
      ),
    ).rejects.toThrow("Secret api-key isn't set for stage prod.");
  });

  it("provides preset secret values and records them for scrubbing", async () => {
    expect(getPresetSecretValue("db-pass")).toBeUndefined();

    const value = await runWithSecretValues({ "db-pass": "p@ssword!" }, async () => {
      return runWithSecretValues({ other: "xyz" }, async () => {
        expect(getPresetSecretValue("db-pass")?.unwrap()).toBe("p@ssword!");
        expect(getPresetSecretValue("other")?.unwrap()).toBe("xyz");
        return getPresetSecretValue("db-pass")!;
      });
    });

    expect(value.unwrap()).toBe("p@ssword!");
    expect(getPresetSecretValue("db-pass")).toBeUndefined();
    expect(scrubSecrets("err p@ssword! xyz")).toBe(
      `err ${REDACTED_VALUE} ${REDACTED_VALUE}`,
    );
  });

  it("scrubs enumerable errors array on Error subclasses without re-exposing seen items", () => {
    const raw = 'sentinel_"err"\\v1';
    recordSecret(raw);
    const base64 = Buffer.from(raw, "utf8").toString("base64");
    const jsonEscaped = JSON.stringify(raw).slice(1, -1);

    class ApiError extends Error {
      readonly errors: Array<{ code: number; message: string }>;
      constructor(message: string, errors: Array<{ code: number; message: string }>) {
        super(message);
        this.name = "ApiError";
        this.errors = errors;
      }
    }

    const original = new ApiError(`failed: ${raw}`, [
      { code: 1000, message: `raw=${raw} b64=${base64} json=${jsonEscaped}` },
    ]);

    const scrubbed = scrubError(original) as ApiError;
    expect(scrubbed).toBeInstanceOf(ApiError);
    expect(scrubbed.message).toBe(`failed: ${REDACTED_VALUE}`);
    expect(Object.prototype.propertyIsEnumerable.call(scrubbed, "errors")).toBe(true);
    expect(scrubbed.errors).toEqual([
      {
        code: 1000,
        message: `raw=${REDACTED_VALUE} b64=${REDACTED_VALUE} json=${REDACTED_VALUE}`,
      },
    ]);
    // Original error stays unmutated.
    expect(original.errors[0]?.message).toContain(raw);
  });
});
