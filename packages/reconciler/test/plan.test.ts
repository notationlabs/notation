import * as v from "valibot";
import { resource } from "@notation/resource";
import { describe, expect, it } from "vitest";
import { decideDriftAction } from "../src/plan";

const Document = resource({ type: "test/plan/document", provider: "test" })
  .defineSchema({
    key: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
    value: { propertyType: "param", presence: "required", value: v.unknown() },
  } as any)
  .defineOperations({
    create: async () => undefined,
    read: async () => ({}) as any,
    update: async () => undefined,
    delete: async () => undefined,
  });

describe("decideDriftAction", () => {
  it("plans an update when the remote holds an object where code has an array", () => {
    const document = new Document("doc", { config: { key: "k" } as any });
    const params = { key: "k", value: { routes: ["a"] } };
    expect(
      decideDriftAction({
        resource: document,
        params,
        driftRead: {
          kind: "present",
          output: { key: "k", value: { routes: { 0: "a" } } },
        },
      }),
    ).toMatchObject({
      decision: "drift-update",
      patch: { value: { routes: ["a"] } },
      diff: { updated: { value: { routes: ["a"] } } },
    });
  });
});
