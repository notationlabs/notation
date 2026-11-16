import { describe, expect, it } from "vitest";
import {
  collectResourceGraph,
  credentialSourceResource,
  isCredentialSource,
  resource,
} from "src";
import { string } from "./validators";

const Env = credentialSourceResource<{
  Params: { key: string };
  Value: string;
}>({ type: "test/sources/Env", provider: "test" })
  .defineSchema({
    key: { propertyType: "param", presence: "required", value: string() },
    revision: {
      propertyType: "computed",
      presence: "required",
      value: string(),
    },
    value: { propertyType: "credential", value: string() },
  } as const)
  .defineOperations({
    read: async (_params, { executionId }) => ({ revision: executionId }),
    loadCredential: async (params) => ({ value: `value of ${params.key}` }),
  });

const Plain = resource<{
  Key: { name: string };
  CreateParams: { name: string };
  UpdateParams: {};
  ReadResult: {};
}>({ type: "test/sources/Plain", provider: "test" })
  .defineSchema({
    name: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      primaryKey: true,
      value: string(),
    },
  } as const)
  .defineOperations({ create: async () => {}, delete: async () => {} });

describe("credentialSourceResource", () => {
  it("builds a class of the kind credential-source, with one credential", async () => {
    const graph = await collectResourceGraph(() => {
      new Env("stripe-key", { config: { key: "STRIPE_KEY" } });
      new Plain("plain", { config: { name: "plain" } });
    });
    const [source, plain] = graph.resources;

    expect(source!.kind).toBe("credential-source");
    expect(isCredentialSource(source!)).toBe(true);
    expect(plain!.kind).toBe("resource");
    expect(isCredentialSource(plain!)).toBe(false);
    expect(Object.keys(source!.credentials)).toEqual(["value"]);
    expect(source!.read).toBeUndefined();
    expect(source!.update).toBeUndefined();
    await expect(source!.create({})).rejects.toThrow(
      "stripe-key is a source, and deploy never creates one",
    );
  });

  it("checks config when the source is declared", async () => {
    await expect(
      collectResourceGraph(() => {
        new Env("stripe-key", { config: { key: 1 as any } });
      }),
    ).rejects.toThrow("Invalid key for stripe-key");
  });
});
