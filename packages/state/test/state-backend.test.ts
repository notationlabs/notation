import { describe, expect, it } from "vitest";
import { MemoryStateBackend, type StateNode } from "src/state";

function createStateNode(
  id: string,
  overrides: Partial<StateNode> = {},
): StateNode {
  return {
    rev: 1,
    id,
    groupId: 1,
    groupType: "stack",
    type: "test/resource",
    config: { name: `${id}-config` },
    params: { name: `${id}-params` },
    output: { name: `${id}-output` },
    lastOperation: "create",
    lastOperationAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryStateBackend", () => {
  it("starts with empty state", async () => {
    const backend = new MemoryStateBackend();

    await expect(backend.get("missing")).resolves.toBeUndefined();
    await expect(backend.values()).resolves.toEqual([]);
  });

  it("returns seeded nodes by id", async () => {
    const node = createStateNode("resource-a");
    const backend = new MemoryStateBackend({ [node.id]: node });

    await expect(backend.get(node.id)).resolves.toEqual(node);
    await expect(backend.get("missing")).resolves.toBeUndefined();
  });

  it("returns values in deterministic id order", async () => {
    const laterNode = createStateNode("resource-z");
    const earlierNode = createStateNode("resource-a");
    const backend = new MemoryStateBackend({
      [laterNode.id]: laterNode,
      [earlierNode.id]: earlierNode,
    });

    await expect(backend.values()).resolves.toEqual([earlierNode, laterNode]);
  });

  it("isolates reads from the seed object and from each other", async () => {
    const node = createStateNode("resource-a");
    const backend = new MemoryStateBackend({ [node.id]: node });

    node.output["name"] = "mutated-seed";
    const read = await backend.get(node.id);
    read!.output["name"] = "mutated-read";

    await expect(backend.get(node.id)).resolves.toMatchObject({
      output: { name: "resource-a-output" },
    });
  });
});
