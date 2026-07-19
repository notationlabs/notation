import { describe, expect, it, vi } from "vitest";
import { resource } from "@notation/resource";
import {
  LeaseConflict,
  MemoryStateBackend,
  RevConflict,
  type StateNode,
} from "@notation/state";
import { Reconciler, createResourceRegistry } from "../src";

function createMemoryState(initial: Record<string, StateNode> = {}) {
  const store: Record<string, StateNode> = { ...initial };

  return {
    store,
    get: vi.fn(async (id: string) => store[id]),
    update: vi.fn(
      async (id: string, expectedRev: number, patch: Partial<StateNode>) => {
        const actualRev = store[id]?.rev ?? 0;
        if (actualRev !== expectedRev) {
          throw new RevConflict(id, expectedRev, store[id]?.rev);
        }
        const rev = actualRev + 1;
        store[id] = {
          ...(store[id] ?? {}),
          ...patch,
          rev,
        } as StateNode;
        return { rev };
      },
    ),
    delete: vi.fn(async (id: string, expectedRev: number) => {
      const actualRev = store[id]?.rev ?? 0;
      if (actualRev !== expectedRev) {
        throw new RevConflict(id, expectedRev, store[id]?.rev);
      }
      delete store[id];
    }),
    values: vi.fn(async () => Object.values(store)),
    lease: vi.fn(async (scope: string, ttl: number) => {
      let expiresAt = new Date(Date.now() + ttl).toISOString();
      return {
        scope,
        get expiresAt() {
          return expiresAt;
        },
        renew: vi.fn(async (nextTtl: number) => {
          expiresAt = new Date(Date.now() + nextTtl).toISOString();
          return expiresAt;
        }),
        release: vi.fn(async () => undefined),
      };
    }),
  };
}

function createTestResourceClass(opts: {
  type: `${string}/${string}/${string}`;
  create?: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | void>;
  read?: (key: Record<string, unknown>) => Promise<Record<string, unknown>>;
  update?: (
    key: Record<string, unknown>,
    patch: Record<string, unknown>,
    params: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => Promise<void>;
  delete?: (
    key: Record<string, unknown>,
    state: Record<string, unknown>,
  ) => Promise<void>;
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
        rev: 1,
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

  it("persists first-time creates with an expect-absent revision", async () => {
    const CreateResource = createTestResourceClass({
      type: "test/service/first-create",
      create: async () => ({ name: "new" }),
      read: async () => ({ name: "new" }),
    });
    const state = createMemoryState();
    const reconciler = new Reconciler({ state, driftDetection: false });

    await reconciler.deploy([
      new CreateResource({ id: "new", config: { name: "new" } }),
    ]);

    expect(state.update).toHaveBeenCalledWith("new", 0, expect.any(Object));
  });

  it("leases a resource before remote create so concurrent deploys cannot duplicate it", async () => {
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let allowCreateToFinish!: () => void;
    const createCanFinish = new Promise<void>((resolve) => {
      allowCreateToFinish = resolve;
    });
    const createSpy = vi.fn(async () => {
      signalCreateStarted();
      await createCanFinish;
      return { name: "new" };
    });
    const CreateResource = createTestResourceClass({
      type: "test/service/concurrent-create",
      create: createSpy,
      read: async () => ({ name: "new" }),
    });
    const state = new MemoryStateBackend();
    const first = new Reconciler({ state, driftDetection: false });
    const second = new Reconciler({ state, driftDetection: false });

    const firstDeploy = first.deploy([
      new CreateResource({ id: "new", config: { name: "new" } }),
    ]);
    await createStarted;

    await expect(
      second.deploy([
        new CreateResource({ id: "new", config: { name: "new" } }),
      ]),
    ).rejects.toBeInstanceOf(LeaseConflict);

    allowCreateToFinish();
    await firstDeploy;
    expect(createSpy).toHaveBeenCalledOnce();
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
    const events: Array<Record<string, unknown>> = [];
    const TestResource = createTestResourceClass({
      type: "test/service/drift",
      read: async () => ({ name: "drifted" }),
      update: updateSpy,
    });

    const state = createMemoryState({
      resource: {
        rev: 1,
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

    const reconciler = new Reconciler({
      state,
      driftDetection: true,
      emit: async (event) => {
        events.push(event as unknown as Record<string, unknown>);
      },
    });
    await reconciler.deploy([
      new TestResource({ id: "resource", config: { name: "desired" } }),
    ]);

    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]?.[1]).toEqual({ name: "desired" });
    expect(events).toContainEqual({
      level: "info",
      event: "reconciler.drift.detected",
      resourceId: "resource",
      resourceType: TestResource.type,
      diff: { name: "desired" },
    });
  });

  it("deletes orphaned state entries by reconstructing from registry", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const OrphanResource = createTestResourceClass({
      type: "test/service/orphan",
      delete: deleteSpy,
    });

    const state = createMemoryState({
      orphan: {
        rev: 1,
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
    expect(state.delete).toHaveBeenCalledWith("orphan", 1);
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
        rev: 1,
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
          operationEvents.push(
            `${event.operation}:${event.status}:${event.resourceId}`,
          );
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
  it("re-reads state and retries destroy on RevConflict", async () => {
    const deleteSpy = vi.fn(async () => undefined);
    const DestroyResource = createTestResourceClass({
      type: "test/service/destroy-retry",
      delete: deleteSpy,
    });
    const state = createMemoryState({
      doomed: {
        rev: 1,
        id: "doomed",
        groupId: -1,
        groupType: "",
        type: DestroyResource.type,
        config: { name: "doomed" },
        params: { name: "doomed" },
        output: { name: "doomed" },
        lastOperation: "create",
        lastOperationAt: new Date().toISOString(),
      },
    });
    state.delete
      .mockRejectedValueOnce(new RevConflict("doomed", 1, 2))
      .mockImplementation(async (id: string) => {
        delete state.store[id];
      });

    const reconciler = new Reconciler({ state });
    await reconciler.destroy([
      new DestroyResource({ id: "doomed", config: { name: "doomed" } }),
    ]);

    expect(state.delete).toHaveBeenCalledTimes(2);
    expect(state.store.doomed).toBeUndefined();
  });

  it("holds a backend lease for the orphan snapshot", async () => {
    const state = createMemoryState();
    const release = vi.fn(async () => undefined);
    const lease = vi.fn(async () => ({
      scope: "reconciler:orphan-deletion",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      renew: vi.fn(async () => new Date(Date.now() + 10_000).toISOString()),
      release,
    }));
    const reconciler = new Reconciler({
      state: { ...state, lease },
      mutationLeaseTtl: 10_000,
    });

    await reconciler.refresh([]);

    expect(lease).toHaveBeenCalledWith("reconciler:orphan-deletion", 10_000);
    expect(state.values).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

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
        rev: 1,
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
        rev: 1,
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
        rev: 1,
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
    expect(state.delete).toHaveBeenCalledWith("a", 1);
    expect(state.delete).toHaveBeenCalledWith("b", 1);
    expect(state.delete).toHaveBeenCalledWith("c", 1);
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
        rev: 1,
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
        rev: 1,
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
    expect(state.delete).toHaveBeenCalledWith("orphan", 1);
    expect(state.delete).not.toHaveBeenCalledWith("keep", expect.anything());
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
        rev: 1,
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
        rev: 1,
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
          operationEvents.push(
            `${event.operation}:${event.status}:${event.resourceId}`,
          );
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
