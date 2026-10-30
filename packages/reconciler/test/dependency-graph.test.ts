import { resource, type BaseResource } from "@notation/resource";
import { describe, expect, it } from "vitest";
import {
  assertDependenciesPresent,
  buildDepthLevels,
  buildResourceDepthLevels,
} from "../src/dependency-graph";

type Item = { id: string; dependsOn: string[] };

function levelsOf(items: Item[]) {
  const { levels, unordered } = buildDepthLevels(
    items,
    (item) => item.id,
    (item) => item.dependsOn,
  );
  return {
    levels: levels.map((level) => level.map((item) => item.id)),
    unordered: unordered.map((item) => item.id),
  };
}

describe("buildDepthLevels", () => {
  it("puts each item in a later level than the items it depends on", () => {
    expect(
      levelsOf([
        { id: "fn", dependsOn: ["role", "zip"] },
        { id: "role", dependsOn: [] },
        { id: "zip", dependsOn: [] },
        { id: "log-group", dependsOn: ["fn"] },
      ]),
    ).toEqual({
      levels: [["role", "zip"], ["fn"], ["log-group"]],
      unordered: [],
    });
  });

  it("ignores an edge to an ID that is not among the items", () => {
    expect(levelsOf([{ id: "fn", dependsOn: ["gone"] }])).toEqual({
      levels: [["fn"]],
      unordered: [],
    });
  });

  it("counts a repeated edge once", () => {
    expect(
      levelsOf([
        { id: "role", dependsOn: [] },
        { id: "fn", dependsOn: ["role", "role"] },
      ]),
    ).toEqual({ levels: [["role"], ["fn"]], unordered: [] });
  });

  it("leaves members of a cycle, and their dependents, unordered in input order", () => {
    expect(
      levelsOf([
        { id: "dependent", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a", "base"] },
        { id: "base", dependsOn: [] },
        { id: "a", dependsOn: ["b"] },
      ]),
    ).toEqual({ levels: [["base"]], unordered: ["dependent", "b", "a"] });
  });

  it("throws on a duplicate ID", () => {
    expect(() =>
      levelsOf([
        { id: "fn", dependsOn: [] },
        { id: "fn", dependsOn: [] },
      ]),
    ).toThrow("Duplicate resource id: fn");
  });
});

describe("buildResourceDepthLevels", () => {
  it("throws on a cycle", () => {
    const Node = resource({ type: "test/graph/node" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const aDependencies: Record<string, BaseResource> = {};
    const a = new Node("a", { dependencies: aDependencies });
    const b = new Node("b", { dependencies: { a } });
    aDependencies.b = b;

    expect(() => buildResourceDepthLevels([a, b])).toThrow(
      "Resource dependency cycle detected",
    );
  });
});

describe("assertDependenciesPresent", () => {
  const Node = resource({ type: "test/graph/node" })
    .defineSchema({})
    .defineOperations({
      create: async () => undefined,
      delete: async () => undefined,
    });

  it("throws when a declared dependency is not among the resources", () => {
    const bucket = new Node("bucket");
    const policy = new Node("policy", { dependencies: { bucket } });

    expect(() => assertDependenciesPresent([policy])).toThrow(
      "policy depends on bucket, which is not part of this deployment. Add bucket to a resource group.",
    );
  });

  it("throws when a dependency added with dependOn is not among the resources", () => {
    const bucket = new Node("bucket");
    const policy = new Node("policy");
    policy.dependOn(bucket);

    expect(() => assertDependenciesPresent([policy])).toThrow(
      "policy depends on bucket",
    );
  });

  it("accepts an empty optional dependency", () => {
    const route = new Node("route", { dependencies: { auth: undefined } });

    expect(() => assertDependenciesPresent([route])).not.toThrow();
  });

  it("accepts a dependency outside the resources whose output is known", () => {
    const bucket = new Node("bucket");
    bucket.setOutput({});
    const policy = new Node("policy", { dependencies: { bucket } });

    expect(() => assertDependenciesPresent([policy])).not.toThrow();
  });

  it("accepts dependencies that are among the resources", () => {
    const bucket = new Node("bucket");
    const policy = new Node("policy", { dependencies: { bucket } });

    expect(() => assertDependenciesPresent([bucket, policy])).not.toThrow();
  });
});
