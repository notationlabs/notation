import { describe, expect, it, vi } from "vitest";
import { resource, type BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { Reconciler, UNKNOWN_AFTER_APPLY } from "../src";

function createMemoryState(initial: Record<string, StateNode> = {}) {
  const store: Record<string, StateNode> = { ...initial };

  return {
    store,
    get: vi.fn(async (id: string) => store[id]),
    update: vi.fn(
      async (id: string, expectedRev: number, patch: Partial<StateNode>) => {
        store[id] = {
          ...(store[id] ?? {}),
          ...patch,
        } as StateNode;
      },
    ),
    delete: vi.fn(async (id: string) => {
      delete store[id];
    }),
    values: vi.fn(async () => Object.values(store)),
    lease: vi.fn(async (scope: string, ttl: number) => ({
      scope,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      renew: vi.fn(async (nextTtl: number) =>
        new Date(Date.now() + nextTtl).toISOString(),
      ),
      release: vi.fn(async () => undefined),
    })),
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
  notFoundOnError?: { name: string; reason: string }[];
}) {
  return resource({ type: opts.type })
    .defineSchema({
      name: {
        presence: "required",
        propertyType: "param",
        valueType: "string" as any,
      },
      tag: {
        presence: "optional",
        propertyType: "param",
        valueType: "string" as any,
      },
    })
    .defineOperations({
      create: opts.create ?? (async () => ({})),
      read: opts.read,
      update: opts.update,
      delete: opts.delete ?? (async () => undefined),
      notFoundOnError: opts.notFoundOnError,
    });
}

function createStateNode(
  id: string,
  type: string,
  params: Record<string, unknown>,
  output: Record<string, unknown> = params,
): StateNode {
  return {
    id,
    groupId: -1,
    groupType: "",
    type,
    config: params,
    params,
    output,
    lastOperation: "create",
    lastOperationAt: new Date().toISOString(),
  };
}

describe("reconciler plan", () => {
  it("plans create for resources without state", async () => {
    const TestResource = createTestResourceClass({
      type: "test/service/plan-create",
    });

    const state = createMemoryState();
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([
      new TestResource({ id: "new", config: { name: "new" } }),
    ]);

    expect(plan.nodes).toEqual([
      {
        id: "new",
        type: TestResource.type,
        decision: "create",
        params: { name: "new" },
        dependsOn: [],
      },
    ]);
  });

  it("plans update with the detailed diff that justified it", async () => {
    const TestResource = createTestResourceClass({
      type: "test/service/plan-update",
    });

    const state = createMemoryState({
      existing: createStateNode("existing", "test/service/plan-update", {
        name: "old",
        tag: "keep",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([
      new TestResource({ id: "existing", config: { name: "new" } }),
    ]);

    expect(plan.nodes).toEqual([
      {
        id: "existing",
        type: TestResource.type,
        decision: "update",
        diff: {
          added: {},
          deleted: { tag: null },
          updated: { name: "new" },
        },
        params: { name: "new" },
        dependsOn: [],
      },
    ]);
  });

  it("plans noop when params match state", async () => {
    const TestResource = createTestResourceClass({
      type: "test/service/plan-noop",
    });

    const state = createMemoryState({
      unchanged: createStateNode("unchanged", "test/service/plan-noop", {
        name: "same",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([
      new TestResource({ id: "unchanged", config: { name: "same" } }),
    ]);

    expect(plan.nodes[0]).toMatchObject({ id: "unchanged", decision: "noop" });
  });

  it("plans drift-update from live read output when drift detection is on", async () => {
    const readSpy = vi.fn(async () => ({ name: "drifted" }));
    const TestResource = createTestResourceClass({
      type: "test/service/plan-drift-update",
      read: readSpy,
    });

    const state = createMemoryState({
      resource: createStateNode("resource", "test/service/plan-drift-update", {
        name: "desired",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: true });

    const plan = await reconciler.plan([
      new TestResource({ id: "resource", config: { name: "desired" } }),
    ]);

    expect(readSpy).toHaveBeenCalledOnce();
    expect(plan.nodes[0]).toEqual({
      id: "resource",
      type: TestResource.type,
      decision: "drift-update",
      diff: {
        added: {},
        deleted: {},
        updated: { name: "desired" },
      },
      params: { name: "desired" },
      dependsOn: [],
    });
  });

  it("plans drift-recreate when the remote resource is gone", async () => {
    const TestResource = createTestResourceClass({
      type: "test/service/plan-drift-recreate",
      read: async () => {
        const err = new Error("gone");
        err.name = "NotFoundException";
        throw err;
      },
      notFoundOnError: [
        { name: "NotFoundException", reason: "deleted remotely" },
      ],
    });

    const state = createMemoryState({
      resource: createStateNode(
        "resource",
        "test/service/plan-drift-recreate",
        { name: "desired" },
      ),
    });
    const reconciler = new Reconciler({ state, driftDetection: true });

    const plan = await reconciler.plan([
      new TestResource({ id: "resource", config: { name: "desired" } }),
    ]);

    expect(plan.nodes[0]).toMatchObject({
      id: "resource",
      decision: "drift-recreate",
    });
  });

  it("skips remote reads when drift detection is off", async () => {
    const readSpy = vi.fn(async () => ({ name: "drifted" }));
    const TestResource = createTestResourceClass({
      type: "test/service/plan-no-read",
      read: readSpy,
    });

    const state = createMemoryState({
      resource: createStateNode("resource", "test/service/plan-no-read", {
        name: "desired",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: false });

    await reconciler.plan([
      new TestResource({ id: "resource", config: { name: "desired" } }),
    ]);

    expect(readSpy).not.toHaveBeenCalled();
  });

  it("plans delete-orphan for state nodes without a matching resource", async () => {
    const state = createMemoryState({
      orphan: createStateNode("orphan", "test/service/plan-orphan", {
        name: "orphan",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([]);

    expect(plan.nodes).toEqual([
      {
        id: "orphan",
        type: "test/service/plan-orphan",
        decision: "delete-orphan",
        params: { name: "orphan" },
        dependsOn: [],
      },
    ]);
  });

  it("populates dependsOn from resource dependencies", async () => {
    const AResource = createTestResourceClass({
      type: "test/service/plan-dep-a",
    });
    const BResource = createTestResourceClass({
      type: "test/service/plan-dep-b",
    });

    const resourceA = new AResource({ id: "a", config: { name: "a" } });
    const resourceB = new BResource({
      id: "b",
      config: { name: "b" },
      dependencies: { a: resourceA },
    });

    const state = createMemoryState();
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([resourceA, resourceB]);

    const nodeB = plan.nodes.find((node) => node.id === "b");
    expect(nodeB?.dependsOn).toEqual(["a"]);
  });

  it("marks params derived from uncreated dependencies as unknown after apply", async () => {
    const AResource = createTestResourceClass({
      type: "test/service/plan-unknown-a",
    });
    const BResource = createTestResourceClass({
      type: "test/service/plan-unknown-b",
    })
      .requireDependencies<{ a: BaseResource }>()
      .deriveParams(({ deps }) => ({
        name: (deps.a.output as { name: string }).name,
      }));

    const resourceA = new AResource({ id: "a", config: { name: "a" } });
    const resourceB = new BResource({
      id: "b",
      config: { tag: "known" },
      dependencies: { a: resourceA },
    });

    const state = createMemoryState();
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([resourceA, resourceB]);

    const nodeB = plan.nodes.find((node) => node.id === "b");
    expect(nodeB).toMatchObject({
      decision: "create",
      params: {
        name: UNKNOWN_AFTER_APPLY,
        tag: "known",
      },
    });
  });

  it("produces a JSON-round-trippable plan", async () => {
    const CreateResource = createTestResourceClass({
      type: "test/service/plan-json-create",
    });
    const UpdateResource = createTestResourceClass({
      type: "test/service/plan-json-update",
    });

    const state = createMemoryState({
      existing: createStateNode("existing", "test/service/plan-json-update", {
        name: "old",
        tag: "gone",
      }),
      orphan: createStateNode("orphan", "test/service/plan-json-orphan", {
        name: "orphan",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: false });

    const plan = await reconciler.plan([
      new CreateResource({ id: "new", config: { name: "new" } }),
      new UpdateResource({ id: "existing", config: { name: "new" } }),
    ]);

    expect(JSON.parse(JSON.stringify(plan))).toStrictEqual(plan);
  });

  it("performs no state writes or resource operations", async () => {
    const createSpy = vi.fn(async () => ({ name: "new" }));
    const updateSpy = vi.fn(async () => undefined);
    const deleteSpy = vi.fn(async () => undefined);

    const CreateResource = createTestResourceClass({
      type: "test/service/plan-pure-create",
      create: createSpy,
      update: updateSpy,
      delete: deleteSpy,
    });
    const UpdateResource = createTestResourceClass({
      type: "test/service/plan-pure-update",
      create: createSpy,
      update: updateSpy,
      delete: deleteSpy,
      read: async () => ({ name: "drifted" }),
    });

    const state = createMemoryState({
      existing: createStateNode("existing", "test/service/plan-pure-update", {
        name: "same",
      }),
      orphan: createStateNode("orphan", "test/service/plan-pure-orphan", {
        name: "orphan",
      }),
    });
    const reconciler = new Reconciler({ state, driftDetection: true });

    await reconciler.plan([
      new CreateResource({ id: "new", config: { name: "new" } }),
      new UpdateResource({ id: "existing", config: { name: "same" } }),
    ]);

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
  });
});
