import { describe, expect, it } from "vitest";
import { runWithSecretContext, type Source } from "@notation/core";
import { Redacted } from "src/sources";
import { SourceValue } from "src/resources/sources";

const versioned = (has: boolean): Source => ({
  name: "vault",
  has: async () => has,
  version: async () => "14",
  get: async () => new Redacted("x"),
});

const unversioned: Source = {
  name: "env",
  has: async () => true,
  get: async () => new Redacted("x"),
};

const inContext = <T>(fn: () => Promise<T>) =>
  runWithSecretContext({ stage: "dev", runId: "exec-1" }, fn);

const valueOf = (source: Source) =>
  new SourceValue("value:stripe-key", {
    config: { Source: source.name, Key: "STRIPE_KEY" },
    source,
    secret: "stripe-key",
  });

describe("SourceValue", () => {
  it("takes its version from the source", async () => {
    await expect(
      inContext(() => valueOf(versioned(true)).getParams()),
    ).resolves.toEqual({ Source: "vault", Key: "STRIPE_KEY", Version: "14" });
  });

  it("takes the run's ID as the version of a source without versions", async () => {
    await expect(
      inContext(() => valueOf(unversioned).getParams()),
    ).resolves.toMatchObject({ Version: "exec-1" });
  });

  it("fails when the source doesn't have the key", async () => {
    await expect(
      inContext(() => valueOf(versioned(false)).planParams()),
    ).rejects.toThrow(
      "`STRIPE_KEY` isn't in the vault source of `stripe-key`.",
    );
  });

  it("never holds the value", async () => {
    const params = await inContext(() => valueOf(versioned(true)).getParams());

    expect(JSON.stringify(params)).not.toContain('"x"');
  });

  it("can be made from its state record, to be deleted", async () => {
    const orphan = new SourceValue("value:old", {
      config: { Source: "env", Key: "OLD" },
    });

    await expect(orphan.delete({}, {} as any)).resolves.toBeUndefined();
  });
});
