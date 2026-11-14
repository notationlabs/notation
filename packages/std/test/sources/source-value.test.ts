import { describe, expect, it } from "vitest";
import {
  declareSecret,
  runWithSecretContext,
  type Source,
} from "@notation/core";
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

const inContext = <T>(source: Source, fn: () => Promise<T>) =>
  runWithSecretContext({ stage: "dev", runId: "exec-1" }, () => {
    declareSecret({
      id: "stripe-key",
      source,
      key: "STRIPE_KEY",
    });
    return fn();
  });

const valueOf = (source: Source) =>
  new SourceValue("value:stripe-key", {
    config: { Secret: "stripe-key", Source: source.name, Key: "STRIPE_KEY" },
  });

const paramsOf = (source: Source) =>
  inContext(source, () => valueOf(source).getParams());

describe("SourceValue", () => {
  it("takes its version from the source", async () => {
    await expect(paramsOf(versioned(true))).resolves.toEqual({
      Secret: "stripe-key",
      Source: "vault",
      Key: "STRIPE_KEY",
      Version: "14",
    });
  });

  it("takes the run's ID as the version of a source without versions", async () => {
    await expect(paramsOf(unversioned)).resolves.toMatchObject({
      Version: "exec-1",
    });
  });

  it("takes the run's ID as the version of a key that the source gives no version", async () => {
    const source: Source = { ...unversioned, version: async () => undefined };
    await expect(paramsOf(source)).resolves.toMatchObject({
      Version: "exec-1",
    });
  });

  it("fails when the source doesn't have the key", async () => {
    const source = versioned(false);
    await expect(
      inContext(source, () => valueOf(source).planParams()),
    ).rejects.toThrow(
      "`STRIPE_KEY` isn't in the vault source of `stripe-key`.",
    );
  });

  it("never holds the value", async () => {
    const params = await paramsOf(versioned(true));

    expect(JSON.stringify(params)).not.toContain('"x"');
  });

  it("can be made from its state record, to be deleted", async () => {
    const orphan = new SourceValue("value:old", {
      config: { Secret: "old", Source: "env", Key: "OLD" },
    });

    await expect(orphan.delete({}, {} as any)).resolves.toBeUndefined();
  });
});
