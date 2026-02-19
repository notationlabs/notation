import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileStateBackend,
  MemoryStateBackend,
  type StateBackend,
  type StateNode,
} from "src/state";

type BackendFixture = {
  backend: StateBackend;
  cleanup: () => Promise<void>;
};

function createStateNode(id: string, overrides: Partial<StateNode> = {}): StateNode {
  return {
    id,
    groupId: 1,
    groupType: "stack",
    type: "test/resource",
    config: { name: `${id}-config` },
    params: { name: `${id}-params` },
    output: { name: `${id}-output` },
    lastOperation: "create",
    lastOperationAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runStateBackendContractTests(
  label: string,
  createBackend: () => Promise<BackendFixture>,
) {
  describe(label, () => {
    it("starts with empty state", async () => {
      const fixture = await createBackend();

      try {
        await expect(fixture.backend.get("missing")).resolves.toBeUndefined();
        await expect(fixture.backend.has("missing")).resolves.toBe(false);
        await expect(fixture.backend.values()).resolves.toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("merges patches on update", async () => {
      const fixture = await createBackend();
      const initialNode = createStateNode("resource-a");

      try {
        await fixture.backend.update(initialNode.id, initialNode);
        await fixture.backend.update(initialNode.id, {
          output: { status: "ready" },
          lastOperation: "update",
        });

        await expect(fixture.backend.get(initialNode.id)).resolves.toEqual({
          ...initialNode,
          output: { status: "ready" },
          lastOperation: "update",
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("deletes values", async () => {
      const fixture = await createBackend();
      const initialNode = createStateNode("resource-a");

      try {
        await fixture.backend.update(initialNode.id, initialNode);
        await fixture.backend.delete(initialNode.id);

        await expect(fixture.backend.get(initialNode.id)).resolves.toBeUndefined();
        await expect(fixture.backend.has(initialNode.id)).resolves.toBe(false);
        await expect(fixture.backend.values()).resolves.toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns all values", async () => {
      const fixture = await createBackend();
      const firstNode = createStateNode("resource-a");
      const secondNode = createStateNode("resource-b");

      try {
        await fixture.backend.update(firstNode.id, firstNode);
        await fixture.backend.update(secondNode.id, secondNode);

        const values = await fixture.backend.values();

        expect(values).toHaveLength(2);
        expect(values).toEqual(expect.arrayContaining([firstNode, secondNode]));
      } finally {
        await fixture.cleanup();
      }
    });
  });
}

runStateBackendContractTests("FileStateBackend", async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "notation-state-"));
  return {
    backend: new FileStateBackend(path.join(tempDirectory, "state.json")),
    cleanup: () => rm(tempDirectory, { recursive: true, force: true }),
  };
});

runStateBackendContractTests("MemoryStateBackend", async () => ({
  backend: new MemoryStateBackend(),
  cleanup: async () => undefined,
}));

describe("MemoryStateBackend", () => {
  it("returns values in deterministic id order", async () => {
    const backend = new MemoryStateBackend();
    const laterNode = createStateNode("resource-z");
    const earlierNode = createStateNode("resource-a");

    await backend.update(laterNode.id, laterNode);
    await backend.update(earlierNode.id, earlierNode);

    await expect(backend.values()).resolves.toEqual([earlierNode, laterNode]);
  });
});
