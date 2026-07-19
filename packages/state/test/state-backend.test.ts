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

function createStateNode(
  id: string,
  overrides: Partial<StateNode> = {},
): StateNode {
  return {
    rev: 0,
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
        await fixture.backend.update(initialNode.id, 0, initialNode);
        await fixture.backend.update(initialNode.id, 1, {
          output: { status: "ready" },
          lastOperation: "update",
        });

        await expect(fixture.backend.get(initialNode.id)).resolves.toEqual({
          ...initialNode,
          rev: 2,
          output: { status: "ready" },
          lastOperation: "update",
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("rejects stale updates and deletes", async () => {
      const fixture = await createBackend();
      const initialNode = createStateNode("resource-a");

      try {
        await expect(
          fixture.backend.update(initialNode.id, 0, initialNode),
        ).resolves.toEqual({ rev: 1 });
        await expect(
          fixture.backend.update(initialNode.id, 0, { output: {} }),
        ).rejects.toMatchObject({
          name: "RevConflict",
          expectedRev: 0,
          actualRev: 1,
        });
        await expect(
          fixture.backend.delete(initialNode.id, 0),
        ).rejects.toMatchObject({
          name: "RevConflict",
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("treats expectedRev 0 as an expect-absent assertion", async () => {
      const fixture = await createBackend();
      const initialNode = createStateNode("resource-a");

      try {
        await expect(
          fixture.backend.update(initialNode.id, 0, initialNode),
        ).resolves.toEqual({ rev: 1 });
        await expect(
          fixture.backend.update(initialNode.id, 0, initialNode),
        ).rejects.toMatchObject({
          name: "RevConflict",
          expectedRev: 0,
          actualRev: 1,
        });
      } finally {
        await fixture.cleanup();
      }
    });

    it("deletes values", async () => {
      const fixture = await createBackend();
      const initialNode = createStateNode("resource-a");

      try {
        await fixture.backend.update(initialNode.id, 0, initialNode);
        await fixture.backend.delete(initialNode.id, 1);

        await expect(
          fixture.backend.get(initialNode.id),
        ).resolves.toBeUndefined();
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
        await fixture.backend.update(firstNode.id, 0, firstNode);
        await fixture.backend.update(secondNode.id, 0, secondNode);

        const values = await fixture.backend.values();

        expect(values).toHaveLength(2);
        expect(values).toEqual(
          expect.arrayContaining([
            { ...firstNode, rev: 1 },
            { ...secondNode, rev: 1 },
          ]),
        );
      } finally {
        await fixture.cleanup();
      }
    });

    it("holds and renews an exclusive lease", async () => {
      const fixture = await createBackend();

      try {
        const lease = await fixture.backend.lease("resource:a", 1_000);
        const firstExpiry = lease.expiresAt;
        await expect(
          fixture.backend.lease("resource:a", 1_000),
        ).rejects.toMatchObject({ name: "LeaseConflict" });

        await lease.renew(2_000);
        expect(lease.expiresAt).not.toBe(firstExpiry);
        await lease.release();

        const next = await fixture.backend.lease("resource:a", 1_000);
        await next.release();
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

describe("FileStateBackend", () => {
  it("serialises concurrent CAS writers so only one wins", async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), "notation-state-"));
    const statePath = path.join(tempDirectory, "state.json");
    const first = new FileStateBackend(statePath);
    const second = new FileStateBackend(statePath);
    const initialNode = createStateNode("resource-a");

    try {
      await first.update(initialNode.id, 0, initialNode);

      const results = await Promise.allSettled([
        first.update(initialNode.id, 1, { output: { writer: "first" } }),
        second.update(initialNode.id, 1, { output: { writer: "second" } }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        name: "RevConflict",
      });
      await expect(first.get(initialNode.id)).resolves.toMatchObject({
        rev: 2,
      });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("MemoryStateBackend", () => {
  it("returns values in deterministic id order", async () => {
    const backend = new MemoryStateBackend();
    const laterNode = createStateNode("resource-z");
    const earlierNode = createStateNode("resource-a");

    await backend.update(laterNode.id, 0, laterNode);
    await backend.update(earlierNode.id, 0, earlierNode);

    await expect(backend.values()).resolves.toEqual([
      { ...earlierNode, rev: 1 },
      { ...laterNode, rev: 1 },
    ]);
  });
});
