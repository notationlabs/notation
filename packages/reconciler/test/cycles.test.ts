import * as v from "valibot";
import { resource, type BaseResource } from "@notation/resource";
import { describe, expect, it } from "vitest";
import {
  ResourceCycleError,
  findStronglyConnected,
  isCycle,
  orderDeployUnits,
  type DeployUnit,
} from "../src/cycles";

const bindingsSchema = {
  name: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  bindings: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.string()),
    collect: (items: string[][]) => items.flat().sort(),
  },
} as const;

const operations = {
  create: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
};

const Worker = resource({ type: "test/cycles/worker", provider: "test" })
  .defineSchema(bindingsSchema as any)
  .defineOperations(operations);

const RequiredBindings = resource({
  type: "test/cycles/required",
  provider: "test",
})
  .defineSchema({
    ...bindingsSchema,
    bindings: { ...bindingsSchema.bindings, presence: "required" },
  } as any)
  .defineOperations(operations);

const RequiredTags = resource({ type: "test/cycles/tags", provider: "test" })
  .defineSchema({
    ...bindingsSchema,
    tags: {
      propertyType: "param",
      presence: "required",
      value: v.array(v.string()),
      collect: (items: string[][]) => items.flat().sort(),
    },
  } as any)
  .defineOperations(operations);

const NoUpdate = resource({ type: "test/cycles/no-update", provider: "test" })
  .defineSchema(bindingsSchema as any)
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });

const worker = (id: string, Class = Worker): BaseResource =>
  new Class(id, { config: { name: id } as any });

const bind = (from: BaseResource, to: BaseResource) =>
  from.contribute({ bindings: [to.outputRef("name")] } as any);

function describeUnits(units: DeployUnit[]) {
  return units.map((unit) =>
    isCycle(unit)
      ? {
          members: unit.members.map((member) => member.id),
          placeholders: unit.placeholders.map((member) => member.id),
        }
      : unit.members[0]!.id,
  );
}

describe("orderDeployUnits", () => {
  it("orders resources with no cycle as the dependency levels do", () => {
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    bind(a, c);

    expect(describeUnits(orderDeployUnits([a, b, c]))).toEqual(["b", "c", "a"]);
  });

  it("makes the first member a placeholder, and orders the others after it", () => {
    const a = worker("a");
    const b = worker("b");
    bind(a, b);
    bind(b, a);

    expect(describeUnits(orderDeployUnits([a, b]))).toEqual([
      { members: ["a", "b"], placeholders: ["a"] },
    ]);
  });

  it("orders a cycle after its dependencies and before its dependents", () => {
    const db = worker("db");
    const a = worker("a");
    const b = worker("b");
    const client = worker("client");
    bind(client, a);
    bind(a, b);
    bind(b, a);
    bind(a, db);

    expect(describeUnits(orderDeployUnits([client, a, b, db]))).toEqual([
      "db",
      { members: ["a", "b"], placeholders: ["a"] },
      "client",
    ]);
  });

  it("skips a member that can't be a placeholder", () => {
    const a = worker("a", RequiredBindings);
    const b = worker("b");
    const c = worker("c", NoUpdate);
    bind(a, b);
    bind(b, c);
    bind(c, a);

    expect(describeUnits(orderDeployUnits([a, b, c]))).toEqual([
      { members: ["b", "a", "c"], placeholders: ["b"] },
    ]);
  });

  it("picks a placeholder for each loop that remains", () => {
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    // a and b form a loop through a's contribution. b and c form another
    // loop, which a placeholder at a does not break.
    bind(a, b);
    b.dependOn(a);
    b.dependOn(c);
    bind(c, b);

    expect(describeUnits(orderDeployUnits([a, b, c]))).toEqual([
      { members: ["a", "c", "b"], placeholders: ["a", "c"] },
    ]);
  });

  it("treats a resource that contributes its own output to itself as a cycle", () => {
    const a = worker("a");
    bind(a, a);

    expect(describeUnits(orderDeployUnits([a]))).toEqual([
      { members: ["a"], placeholders: ["a"] },
    ]);
  });

  it("fails when a loop is closed by dependOn alone, and says why for each member", () => {
    const a = worker("a");
    const b = worker("b");
    a.dependOn(b);
    b.dependOn(a);

    expect(() => orderDeployUnits([a, b])).toThrow(ResourceCycleError);
    expect(() => orderDeployUnits([a, b])).toThrow(
      "The resources a and b depend on each other, and none of them can be created first.",
    );
    expect(() => orderDeployUnits([a, b])).toThrow(
      "- a depends on b through its config, its dependencies or dependOn, not through contributions.",
    );
  });

  it("fails when no member's contributed params can be left out", () => {
    const a = worker("a", RequiredBindings);
    const b = worker("b", NoUpdate);
    bind(a, b);
    bind(b, a);

    let message = "";
    try {
      orderDeployUnits([a, b]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "- a takes bindings from contributions that refer to other members of its cycle, and bindings is required.",
    );
    expect(message).toContain(
      "- test/cycles/no-update has no update operation, so b can't be updated after it is created.",
    );
  });

  it("checks only the params that the contributions that refer to peers set", () => {
    const a = worker("a", RequiredTags);
    const b = worker("b", NoUpdate);
    a.contribute({ tags: ["static"] } as any);
    bind(a, b);
    bind(b, a);

    expect(describeUnits(orderDeployUnits([a, b]))).toEqual([
      { members: ["a", "b"], placeholders: ["a"] },
    ]);
  });

  it("fails when a loop remains through a placeholder, and gives a reason only for the other members", () => {
    const a = worker("a");
    const b = worker("b");
    const c = worker("c");
    // a becomes the placeholder for its contribution from b, but its
    // dependOn on c keeps the loop a → c → b → a.
    bind(a, b);
    a.dependOn(c);
    b.dependOn(a);
    c.dependOn(b);

    let message = "";
    try {
      orderDeployUnits([a, b, c]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      "- b depends on a through its config, its dependencies or dependOn, not through contributions.",
    );
    expect(message).toContain(
      "- c depends on b through its config, its dependencies or dependOn, not through contributions.",
    );
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("- a ");
  });

  it("fails on a duplicate ID", () => {
    expect(() => orderDeployUnits([worker("a"), worker("a")])).toThrow(
      "Duplicate resource id: a",
    );
  });
});

describe("findStronglyConnected", () => {
  it("returns the components, each in input order", () => {
    const edges: Record<string, string[]> = {
      a: ["b"],
      b: ["c"],
      c: ["a"],
      d: ["a"],
      e: [],
    };
    const components = findStronglyConnected(
      Object.keys(edges),
      (id) => edges[id]!,
    );

    expect(components).toEqual([["a", "b", "c"], ["d"], ["e"]]);
  });
});
