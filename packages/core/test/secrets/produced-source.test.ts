import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";
import { collectResourceGraph, resource } from "@notation/resource";
import {
  deleteSecretValue,
  hasSecretValue,
  isProducedSource,
  producedSource,
  registerSecretStore,
  writeSecretValues,
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
  delete: async (params) => {
    held.delete(params.name as string);
  },
  has: async (params) => held.has(params.name as string),
});

const target = (name: string): SecretTarget => ({
  provider: "@example/store",
  params: { name },
});

beforeEach(() => {
  held.clear();
  rejected = [];
});

describe("writeSecretValues", () => {
  it("writes each value to its target", async () => {
    await writeSecretValues([
      [target("a"), "value-a"],
      [target("b"), "value-b"],
    ]);

    expect(Object.fromEntries(held)).toEqual({ a: "value-a", b: "value-b" });
    await expect(hasSecretValue(target("a"))).resolves.toBe(true);
    await deleteSecretValue(target("a"));
    await expect(hasSecretValue(target("a"))).resolves.toBe(false);
  });

  it("fails for a provider that no loaded package registered", async () => {
    await expect(
      hasSecretValue({ provider: "@example/missing", params: {} }),
    ).rejects.toThrow(
      "No secret store is registered for @example/missing. The package that provides it isn't loaded.",
    );
  });

  it("deletes the values it wrote when a later write fails, and says a secret may be empty", async () => {
    rejected = ["bad"];

    const error = await writeSecretValues([
      [target("a"), "value-a"],
      [target("bad"), "value-b"],
    ]).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "rejected. The values written to the other secrets before it were deleted, so a secret that held an earlier value may now be empty. The next plan shows each one as drift.",
    );
    expect(held.size).toBe(0);
  });

  it("throws the error of a first write that fails as it is", async () => {
    rejected = ["bad"];

    await expect(
      writeSecretValues([[target("bad"), "value"]]),
    ).rejects.toThrow(/^rejected$/);
  });
});

type HolderSchema = {
  Key: { Id: string };
  CreateParams: { Id: string; Targets: SecretTarget[] };
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
    Targets: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      value: v.array(
        v.object({
          provider: v.string(),
          params: v.record(v.string(), v.any()),
        }),
      ),
      collect: (items: unknown[]) => items.flat() as SecretTarget[],
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
      param: "Targets",
    });

  it("contributes each registered target to the param", async () => {
    let holder!: InstanceType<typeof Holder>;
    await collectResourceGraph(() => {
      holder = new Holder("holder", { config: { Id: "h" } });
      const value = source(holder);
      expect(isProducedSource(value)).toBe(true);
      value["~producedSource"].register(target("a"));
      value["~producedSource"].register(target("b"));
    });

    expect((await holder.getParams()).Targets).toEqual([
      target("a"),
      target("b"),
    ]);
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
