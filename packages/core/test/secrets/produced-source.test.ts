import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";
import { collectResourceGraph, resource } from "@notation/resource";
import {
  isProducedSource,
  producedSource,
  registerSecretStore,
  writeSecretValue,
  type SecretTarget,
} from "src/secrets";

const held = new Map<string, string>();
let rejected: string[];

registerSecretStore("@example/store", {
  write: async (params, value) => {
    if (rejected.includes(params.name as string)) {
      throw new Error("rejected");
    }
    held.set(params.name as string, value);
  },
});

const target = (name: string): SecretTarget => ({
  provider: "@example/store",
  params: { name },
});

beforeEach(() => {
  held.clear();
  rejected = [];
});

describe("writeSecretValue", () => {
  it("writes the value to the target", async () => {
    await writeSecretValue(target("a"), "value-a");

    expect(Object.fromEntries(held)).toEqual({ a: "value-a" });
  });

  it("fails for a provider that no loaded package registered", async () => {
    await expect(
      writeSecretValue({ provider: "@example/missing", params: {} }, "value"),
    ).rejects.toThrow(
      "No secret store is registered for @example/missing. The package that provides it isn't loaded.",
    );
  });

  it("throws the error of a write that fails", async () => {
    rejected = ["bad"];

    await expect(writeSecretValue(target("bad"), "value")).rejects.toThrow(
      /^rejected$/,
    );
  });
});

type HolderSchema = {
  Key: { Id: string };
  CreateParams: { Id: string; Target: SecretTarget };
  UpdateParams: {};
  ReadResult: {};
};

const Holder = resource<HolderSchema>({
  type: "test/holder/Holder",
  provider: "@example/holder",
})
  .defineSchema({
    Id: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      primaryKey: true,
      value: v.string(),
    },
    Target: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      value: v.object({
        provider: v.string(),
        params: v.record(v.string(), v.any()),
      }),
      collect: (items: unknown[]) => items[0] as SecretTarget,
    },
  } as const)
  .defineOperations({
    create: async () => {},
    delete: async () => {},
  });

describe("producedSource", () => {
  const source = (holder: InstanceType<typeof Holder>) =>
    producedSource({
      producer: 'holder({ id: "h" })',
      resource: holder,
      name: "value",
      param: "Target",
    });

  it("contributes the registered target to the param", async () => {
    let holder!: InstanceType<typeof Holder>;
    await collectResourceGraph(() => {
      holder = new Holder("holder", { config: { Id: "h" } });
      const value = source(holder);
      expect(isProducedSource(value)).toBe(true);
      value["~producedSource"].register(target("a"), 'secret({ id: "a" })');
    });

    expect((await holder.getParams()).Target).toEqual(target("a"));
  });

  it("throws when a second secret takes the source", async () => {
    await expect(
      collectResourceGraph(() => {
        const value = source(new Holder("holder", { config: { Id: "h" } }));
        value["~producedSource"].register(target("a"), 'secret({ id: "a" })');
        value["~producedSource"].register(target("b"), 'secret({ id: "b" })');
      }),
    ).rejects.toThrow(
      'secret({ id: "b" }) can\'t take holder({ id: "h" }).sources.value, because secret({ id: "a" }) takes it. Only one secret can take a produced source.',
    );
  });

  it("throws when evaluation ends and no secret takes the source", async () => {
    await expect(
      collectResourceGraph(() => {
        source(new Holder("holder", { config: { Id: "h" } }));
      }),
    ).rejects.toThrow(
      'No secret takes holder({ id: "h" }).sources.value. Only the create of holder({ id: "h" }) gets the value, so the value would be lost.',
    );
  });
});
