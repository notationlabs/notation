import { describe, expect, it, vi } from "vitest";
import { resource } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { Reconciler, createResourceRegistry } from "../src";

function createMemoryState(initial: Record<string, StateNode> = {}) {
  const store: Record<string, StateNode> = { ...initial };

  return {
    store,
    get: vi.fn(async (id: string) => store[id]),
    update: vi.fn(async (id: string, patch: Partial<StateNode>) => {
      store[id] = {
        ...(store[id] ?? {}),
        ...patch,
      } as StateNode;
    }),
    delete: vi.fn(async (id: string) => {
      delete store[id];
    }),
    values: vi.fn(async () => Object.values(store)),
  };
}

function createTestResourceClass(opts: {
  type: `${string}/${string}/${string}`;
  create?: (params: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  read?: (key: Record<string, unknown>) => Promise<Record<string, unknown>>;
  update?: (
    key: Record<string, unknown>,
    patch: Record<string, unknown>,
    params: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => Promise<void>;
  delete?: (key: Record<string, unknown>, state: Record<string, unknown>) => Promise<void>;
}) {
  return resource({ type: opts.type })
    .defineSchema({
      name: {
        presence: "required",
        propertyType: "param",
        valueType: "string" as any,
      },
    })
    .defineOperations({
      create: opts.create ?? (async () => ({})),
      read: opts.read,
      update: opts.update,
      delete: opts.delete ?? (async () => undefined),
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("reconciler deploy", () => {
  it("chooses create vs update from desired params vs state", async () => {
    const createSpy = vi.fn(async () => ({ name: "new" }));
    const updateSpy = vi.fn(async () => undefined);

    const CreateResource = createTestResourceClass({
      type: "test/service/create-choice",
      create: createSpy,
      read: async () => ({ name: "new" }),
    });
    const UpdateResource = createTestResourceClass({
      type: "test/service/update-choice",
      update: updateSpy,
      read: async () => ({ name: "new" }),
    });

    const state = createMemoryState({
      existing: {
        id: "existing",
        groupId: -1,
        groupType: "",
        type: UpdateResource.type,
        config: { name: "old" },
        params: { name: "old" },
        output: { name: "old" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const events: string[] = [];
    const reconciler = new Reconciler({
      state,
      driftDetection: false,
      emit: async (event) => {
        if ("operation" in event) {
          events.push(`${event.operation}:${event.status}:${event.resourceId}`);
        }
      },
    });

    await reconciler.deploy([
      new CreateResource({ id: "new", config: { name: "new" } }),
      new UpdateResource({ id: "existing", config: { name: "new" } }),
    ]);

    expect(createSpy).toHaveBeenCalledOnce();
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[1]).toEqual({ name: "new" });
    expect(events).toContain("create:success:new");
    expect(events).toContain("update:success:existing");
  });

  it("runs independent resources concurrently per dependency depth", async () => {
    const marks: Record<string, number> = {};

    const AResource = createTestResourceClass({
      type: "test/service/a",
      create: async () => {
        marks.aStart = Date.now();
        await sleep(60);
        marks.aEnd = Date.now();
        return { name: "a" };
      },
      read: async () => ({ name: "a" }),
    });
    const CResource = createTestResourceClass({
      type: "test/service/c",
      create: async () => {
        marks.cStart = Date.now();
        await sleep(60);
        marks.cEnd = Date.now();
        return { name: "c" };
      },
      read: async () => ({ name: "c" }),
    });
    const BResource = createTestResourceClass({
      type: "test/service/b",
      create: async () => {
        marks.bStart = Date.now();
        return { name: "b" };
      },
      read: async () => ({ name: "b" }),
    });

    const state = createMemoryState();
    const resourceA = new AResource({ id: "a", config: { name: "a" } });
    const resourceB = new BResource({
      id: "b",
      config: { name: "b" },
      dependencies: { a: resourceA },
    });
    const resourceC = new CResource({ id: "c", config: { name: "c" } });

    const reconciler = new Reconciler({ state, driftDetection: false });
    await reconciler.deploy([resourceA, resourceB, resourceC]);

    expect(Math.abs(marks.aStart - marks.cStart)).toBeLessThan(40);
    expect(marks.bStart).toBeGreaterThanOrEqual(marks.aEnd);
  });

  it("detects drift using live read output and converges with update", async () => {
    const updateSpy = vi.fn(async () => undefined);
    const TestResource = createTestResourceClass({
      type: "test/service/drift",
      read: async () => ({ name: "drifted" }),
      update: updateSpy,
    });

    const state = createMemoryState({
      resource: {
        id: "resource",
        groupId: -1,
        groupType: "",
        type: TestResource.type,
        config: { name: "desired" },
        params: { name: "desired" },
        output: { name: "desired" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const reconciler = new Reconciler({ state, driftDetection: true });
    await reconciler.deploy([
      new TestResource({ id: "resource", config: { name: "desired" } }),
    ]);

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[1]).toEqual({ name: "desired" });
  });

  it("deletes orphaned state entries by reconstructing from registry", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const OrphanResource = createTestResourceClass({
      type: "test/service/orphan",
      delete: deleteSpy,
    });

    const state = createMemoryState({
      orphan: {
        id: "orphan",
        groupId: -1,
        groupType: "",
        type: OrphanResource.type,
        config: { name: "from-state" },
        params: { name: "from-state" },
        output: { name: "from-state" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const reconciler = new Reconciler({
      state,
      registry: createResourceRegistry([OrphanResource]),
      driftDetection: false,
    });

    await reconciler.deploy([]);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(state.delete).toHaveBeenCalledWith("orphan");
  });

  it("dryRun emits operation intent without applying side effects", async () => {
    const createSpy = vi.fn(async () => ({ name: "new" }));
    const deleteSpy = vi.fn(async () => undefined);

    const CreateResource = createTestResourceClass({
      type: "test/service/dry-run-create",
      create: createSpy,
      read: async () => ({ name: "new" }),
    });
    const OrphanResource = createTestResourceClass({
      type: "test/service/dry-run-orphan",
      delete: deleteSpy,
    });

    const state = createMemoryState({
      orphan: {
        id: "orphan",
        groupId: -1,
        groupType: "",
        type: OrphanResource.type,
        config: { name: "orphan" },
        params: { name: "orphan" },
        output: { name: "orphan" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const operationEvents: string[] = [];
    const reconciler = new Reconciler({
      state,
      registry: createResourceRegistry([OrphanResource]),
      dryRun: true,
      driftDetection: false,
      emit: async (event) => {
        if ("operation" in event) {
          operationEvents.push(`${event.operation}:${event.status}:${event.resourceId}`);
        }
      },
    });

    await reconciler.deploy([
      new CreateResource({ id: "new", config: { name: "new" } }),
    ]);

    expect(createSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    expect(operationEvents).toContain("create:dry-run:new");
    expect(operationEvents).toContain("delete:dry-run:orphan");
  });
});

describe("reconciler destroy + refresh", () => {
  it("destroys resources in reverse dependency order", async () => {
    const destroyOrder: string[] = [];
    const deleteA = vi.fn(async () => {
      destroyOrder.push("a");
    });
    const deleteB = vi.fn(async () => {
      destroyOrder.push("b");
    });
    const deleteC = vi.fn(async () => {
      destroyOrder.push("c");
    });

    const AResource = createTestResourceClass({
      type: "test/service/destroy-a",
      delete: deleteA,
    });
    const BResource = createTestResourceClass({
      type: "test/service/destroy-b",
      delete: deleteB,
    });
    const CResource = createTestResourceClass({
      type: "test/service/destroy-c",
      delete: deleteC,
    });

    const resourceA = new AResource({ id: "a", config: { name: "a" } });
    const resourceB = new BResource({
      id: "b",
      config: { name: "b" },
      dependencies: { a: resourceA },
    });
    const resourceC = new CResource({
      id: "c",
      config: { name: "c" },
      dependencies: { b: resourceB },
    });

    const state = createMemoryState({
      a: {
        id: "a",
        groupId: -1,
        groupType: "",
        type: AResource.type,
        config: { name: "a" },
        params: { name: "a" },
        output: { name: "a" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
      b: {
        id: "b",
        groupId: -1,
        groupType: "",
        type: BResource.type,
        config: { name: "b" },
        params: { name: "b" },
        output: { name: "b" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
      c: {
        id: "c",
        groupId: -1,
        groupType: "",
        type: CResource.type,
        config: { name: "c" },
        params: { name: "c" },
        output: { name: "c" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const reconciler = new Reconciler({ state });
    await reconciler.destroy([resourceA, resourceB, resourceC]);

    expect(destroyOrder).toEqual(["c", "b", "a"]);
    expect(state.delete).toHaveBeenCalledWith("a");
    expect(state.delete).toHaveBeenCalledWith("b");
    expect(state.delete).toHaveBeenCalledWith("c");
  });

  it("refresh removes orphan state entries", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const OrphanResource = createTestResourceClass({
      type: "test/service/refresh-orphan",
      delete: deleteSpy,
    });
    const KeepResource = createTestResourceClass({
      type: "test/service/refresh-keep",
    });

    const keep = new KeepResource({ id: "keep", config: { name: "keep" } });
    const state = createMemoryState({
      keep: {
        id: "keep",
        groupId: -1,
        groupType: "",
        type: KeepResource.type,
        config: { name: "keep" },
        params: { name: "keep" },
        output: { name: "keep" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
      orphan: {
        id: "orphan",
        groupId: -1,
        groupType: "",
        type: OrphanResource.type,
        config: { name: "orphan" },
        params: { name: "orphan" },
        output: { name: "orphan" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const reconciler = new Reconciler({
      state,
      registry: createResourceRegistry([OrphanResource]),
    });

    await reconciler.refresh([keep]);

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(state.delete).toHaveBeenCalledWith("orphan");
    expect(state.delete).not.toHaveBeenCalledWith("keep");
  });

  it("destroy and refresh dryRun emit operation events without side effects", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const DestroyResource = createTestResourceClass({
      type: "test/service/dry-run-destroy",
      delete: deleteSpy,
    });
    const OrphanResource = createTestResourceClass({
      type: "test/service/dry-run-refresh",
      delete: deleteSpy,
    });

    const destroyResource = new DestroyResource({
      id: "destroy-me",
      config: { name: "destroy-me" },
    });

    const state = createMemoryState({
      "destroy-me": {
        id: "destroy-me",
        groupId: -1,
        groupType: "",
        type: DestroyResource.type,
        config: { name: "destroy-me" },
        params: { name: "destroy-me" },
        output: { name: "destroy-me" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
      orphan: {
        id: "orphan",
        groupId: -1,
        groupType: "",
        type: OrphanResource.type,
        config: { name: "orphan" },
        params: { name: "orphan" },
        output: { name: "orphan" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });

    const operationEvents: string[] = [];
    const reconciler = new Reconciler({
      state,
      dryRun: true,
      registry: createResourceRegistry([OrphanResource]),
      emit: async (event) => {
        if ("operation" in event) {
          operationEvents.push(`${event.operation}:${event.status}:${event.resourceId}`);
        }
      },
    });

    await reconciler.destroy([destroyResource]);
    await reconciler.refresh([destroyResource]);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    expect(operationEvents).toContain("delete:dry-run:destroy-me");
    expect(operationEvents).toContain("delete:dry-run:orphan");
  });
});
