import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declareSecret,
  runWithSecretContext,
  scrubSecretValues,
  setConfigFile,
  type SecretContextOptions,
  type Source,
} from "@notation/core";
import { collectResourceGraph, type BaseResource } from "@notation/resource";
import { clearSecretValues } from "@notation/utils";
import { Redacted, dotenv, env, getValue, isValueSupplied } from "src/sources";

const context = { stage: "dev" };
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-std-sources-"));
  setConfigFile(path.join(directory, "notation.config.ts"));
});

afterEach(async () => {
  setConfigFile(undefined);
  vi.unstubAllEnvs();
  clearSecretValues();
  await rm(directory, { recursive: true, force: true });
});

describe("env", () => {
  it("reads process.env", async () => {
    vi.stubEnv("SENTRY_DSN", "https://key@sentry.io/1");

    expect(env.name).toBe("env");
    expect(env.version).toBeUndefined();
    await expect(env.has("SENTRY_DSN", context)).resolves.toBe(true);
    await expect(env.has("MISSING", context)).resolves.toBe(false);
    expect((await env.get("SENTRY_DSN", context)).unwrap()).toBe(
      "https://key@sentry.io/1",
    );
  });
});

describe("dotenv", () => {
  it("reads a file relative to the project root", async () => {
    await writeFile(
      path.join(directory, ".env.local"),
      "WEBHOOK_SECRET=whsec_1\n",
    );
    const source = dotenv(".env.local");

    expect(source.name).toBe("dotenv");
    await expect(source.has("WEBHOOK_SECRET", context)).resolves.toBe(true);
    expect((await source.get("WEBHOOK_SECRET", context)).unwrap()).toBe(
      "whsec_1",
    );
  });

  it("counts a missing file as empty", async () => {
    const source = dotenv(".env.missing");

    await expect(source.has("WEBHOOK_SECRET", context)).resolves.toBe(false);
    await expect(source.get("WEBHOOK_SECRET", context)).rejects.toThrow(
      "`WEBHOOK_SECRET` isn't in .env.missing.",
    );
  });

  it("parses comments, export, quotes and values that span lines", async () => {
    await writeFile(
      path.join(directory, ".env"),
      [
        "# a comment",
        "export A=1",
        "B = two words  # trailing comment",
        "C='single # not a comment'",
        'D="line\\nbreak"',
        'E="spans',
        'lines"',
        "F=",
        "B=override",
      ].join("\r\n"),
    );
    const source = dotenv(".env");
    const read = async (key: string) =>
      (await source.get(key, context)).unwrap();

    expect({
      A: await read("A"),
      B: await read("B"),
      C: await read("C"),
      D: await read("D"),
      E: await read("E"),
      F: await read("F"),
    }).toEqual({
      A: "1",
      B: "override",
      C: "single # not a comment",
      D: "line\nbreak",
      E: "spans\nlines",
      F: "",
    });
  });
});

describe("getValue", () => {
  const source: Source = {
    name: "vault",
    has: async () => true,
    get: async (key, { stage }) => new Redacted(`${key}@${stage}`),
  };

  const resource = {} as BaseResource;

  function inContext<T>(
    options: Partial<SecretContextOptions>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return runWithSecretContext(
      { stage: "dev", runId: "run", ...options },
      async () => {
        await collectResourceGraph(() => {
          declareSecret({ id: "stripe-key", resource, source, key: "STRIPE" });
          declareSecret({ id: "admin", resource });
        });
        return fn();
      },
    );
  }

  it("gets the value from the secret's source, and records it for scrubbing", async () => {
    const value = await inContext({}, () => getValue("stripe-key"));

    expect(value.unwrap()).toBe("STRIPE@dev");
    expect(scrubSecretValues("echo STRIPE@dev")).toBe("echo <hidden>");
  });

  it("asks the prompt for a secret without a source", async () => {
    const prompt = vi.fn(async () => "hunter2");

    const value = await inContext({ prompt }, () => getValue("admin"));

    expect(value.unwrap()).toBe("hunter2");
    expect(prompt).toHaveBeenCalledWith({ id: "admin", stage: "dev" });
  });

  it("fails with the command to run for a secret without a source and no prompt", async () => {
    await expect(inContext({}, () => getValue("admin"))).rejects.toThrow(
      "Secret `admin` isn't set for stage dev. Run `notation secret set admin --stage dev`.",
    );
  });

  it("returns the value that notation secret set supplied", async () => {
    const supplied = { id: "stripe-key", value: new Redacted("sk_set") };

    const result = await inContext({ supplied }, async () => ({
      value: (await getValue("stripe-key")).unwrap(),
      supplied: isValueSupplied("stripe-key"),
      other: isValueSupplied("admin"),
    }));

    expect(result).toEqual({ value: "sk_set", supplied: true, other: false });
  });

  it("fails outside a secret context", async () => {
    await expect(getValue("admin")).rejects.toThrow(
      "can only be read in notation deploy or notation secret set",
    );
  });
});
