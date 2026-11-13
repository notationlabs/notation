import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REDACTED_VALUE,
  Redacted,
  clearRecordedSecrets,
  clearSecretTargets,
  runWithExecutionContext,
  runWithSecretPromptHandler,
  runWithSecretValues,
  scrubSecrets,
} from "@notation/core";
import { setConfigFile } from "@notation/core/paths";
import type { BaseResource } from "@notation/resource";
import {
  dotenv,
  env,
  getValue,
  registerSecretTarget,
  type Source,
} from "src/sources";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-std-sources-"));
  await writeFile(path.join(directory, "notation.config.ts"), "export default {};\n");
  setConfigFile(path.join(directory, "notation.config.ts"));
});

afterEach(async () => {
  setConfigFile(undefined);
  clearRecordedSecrets();
  clearSecretTargets();
  await rm(directory, { recursive: true, force: true });
});

describe("env source", () => {
  it("reads from process.env and returns Redacted<string>", async () => {
    const key = "NOTATION_TEST_ENV_SECRET";
    const prev = process.env[key];
    process.env[key] = "env-secret-value";
    try {
      expect(env.name).toBe("env");
      expect(env.version).toBeUndefined();
      expect(await env.has(key, { stage: "dev" })).toBe(true);
      expect(await env.has("NOTATION_MISSING_KEY", { stage: "dev" })).toBe(false);

      const value = await env.get(key, { stage: "dev" });
      expect(Redacted.is(value)).toBe(true);
      expect(value.unwrap()).toBe("env-secret-value");
      expect(() => String(value)).toThrow(TypeError);

      await expect(
        env.get("NOTATION_MISSING_KEY", { stage: "dev" }),
      ).rejects.toThrow(/NOTATION_MISSING_KEY/);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});

describe("dotenv source", () => {
  it("parses comments, blank lines, export prefix, quotes, escapes, and inline comments via node:util.parseEnv", async () => {
    await writeFile(
      path.join(directory, ".env.cases"),
      [
        "# Full line comment",
        "",
        "   # Indented comment",
        "PLAIN=hello-world",
        "UNQUOTED_COMMENT=foo bar   # inline comment",
        "export EXPORTED=exported-val",
        'DOUBLE="line1\\nline2"',
        "SINGLE='raw\\nvalue # not a comment'",
        "BACKTICK=`bt # val`",
        "EMPTY=",
        "EMPTY_COMMENT= # nothing",
        'MULTILINE="first',
        'second"',
      ].join("\n"),
    );

    const source = dotenv(".env.cases");
    const expected: Record<string, string> = {
      PLAIN: "hello-world",
      UNQUOTED_COMMENT: "foo bar",
      EXPORTED: "exported-val",
      DOUBLE: "line1\nline2",
      SINGLE: "raw\\nvalue # not a comment",
      BACKTICK: "bt # val",
      EMPTY: "",
      EMPTY_COMMENT: "",
      MULTILINE: "first\nsecond",
    };

    for (const [k, v] of Object.entries(expected)) {
      expect(await source.has(k, { stage: "dev" })).toBe(true);
      expect((await source.get(k, { stage: "dev" })).unwrap()).toBe(v);
    }
  });

  it("reads from project-root-relative path and treats missing file as empty", async () => {
    const missing = dotenv(".env.missing");
    expect(missing.name).toBe("dotenv");
    expect(missing.version).toBeUndefined();
    expect(await missing.has("SECRET", { stage: "dev" })).toBe(false);
    await expect(missing.get("SECRET", { stage: "dev" })).rejects.toThrow();

    await writeFile(
      path.join(directory, ".env.local"),
      'export WEBHOOK_SECRET="whsec_12345" # secret\n',
    );
    const local = dotenv(".env.local");
    expect(await local.has("WEBHOOK_SECRET", { stage: "dev" })).toBe(true);
    const value = await local.get("WEBHOOK_SECRET", { stage: "dev" });
    expect(Redacted.is(value)).toBe(true);
    expect(value.unwrap()).toBe("whsec_12345");
  });
});

describe("getValue", () => {
  it("fetches from registered source and records raw value for scrubbing", async () => {
    const mockSource: Source = {
      name: "vault",
      async has(key, { stage }) {
        return key === "STRIPE_KEY" && stage === "prod";
      },
      async get(key, { stage }) {
        return new Redacted(`vault-${stage}-${key}-sentinel`);
      },
    };
    registerSecretTarget({
      id: "stripe-key",
      resource: { id: "secret:stripe-key" } as BaseResource,
      source: mockSource,
      key: "STRIPE_KEY",
    });

    const val = await runWithExecutionContext(
      { stage: "prod", executionId: "exec-1" },
      () => getValue("stripe-key"),
    );

    expect(val.unwrap()).toBe("vault-prod-STRIPE_KEY-sentinel");
    expect(scrubSecrets("Error: vault-prod-STRIPE_KEY-sentinel")).toBe(
      `Error: ${REDACTED_VALUE}`,
    );
  });

  it("uses prompt handler for sourceless secrets or fails cleanly without one", async () => {
    registerSecretTarget({
      id: "admin-password",
      resource: { id: "secret:admin-password" } as BaseResource,
    });

    await expect(
      runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
        getValue("admin-password"),
      ),
    ).rejects.toThrow(
      "Secret admin-password isn't set for stage dev. Run notation secret set admin-password --stage dev.",
    );

    const prompted = await runWithExecutionContext(
      { stage: "dev", executionId: "e1" },
      () =>
        runWithSecretPromptHandler(
          async ({ id, stage }) => `prompt-${id}-${stage}`,
          () => getValue("admin-password"),
        ),
    );
    expect(prompted.unwrap()).toBe("prompt-admin-password-dev");
    expect(scrubSecrets("leak prompt-admin-password-dev")).toBe(
      `leak ${REDACTED_VALUE}`,
    );
  });

  it("uses preset override even when target has a source", async () => {
    registerSecretTarget({
      id: "sourced",
      resource: { id: "secret:sourced" } as BaseResource,
      source: env,
      key: "NONEXISTENT_KEY",
    });

    const result = await runWithSecretValues({ sourced: "manual-override" }, () =>
      getValue("sourced"),
    );
    expect(result.unwrap()).toBe("manual-override");
    expect(scrubSecrets("echo manual-override")).toBe(
      `echo ${REDACTED_VALUE}`,
    );
  });

  it("throws with known secret IDs when id is unknown", async () => {
    registerSecretTarget({
      id: "first",
      resource: { id: "secret:first" } as BaseResource,
    });

    await expect(
      runWithExecutionContext({ stage: "dev", executionId: "e1" }, () =>
        getValue("missing"),
      ),
    ).rejects.toThrow(/Unknown secret "missing"\. Known secrets: first\./);
  });
});
