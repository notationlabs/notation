import * as v from "valibot";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkflowRouter, workflow } from "@notation/durable";
import { WorkflowRunner } from "@notation/durable/runtime";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import { resource, type BaseResource } from "@notation/resource";
import { MemoryStateBackend } from "@notation/state";
import * as durable from "../src/durable";
import type { ReconcilerEvent } from "../src/events";
import { createPlan } from "../src/planner";

const logger = pino({ level: "silent" });

function createTestRuntime() {
  const database = createSqliteDb({ path: ":memory:" });
  const runtime = new SqliteRuntime(database);
  const state = new durable.DurableStateBackend(runtime.stores, "test:dev");

  async function runDeploy(
    executionId: string,
    resources: BaseResource[],
    opts: {
      dryRun?: boolean;
      driftDetection?: boolean;
      emit?: (event: ReconcilerEvent) => void;
    } = {},
  ) {
    const deploy = workflow(async function* (step, event) {
      yield* durable.deploy(step, {
        executionId: event.executionId,
        resources,
        state,
        driftDetection: opts.driftDetection ?? true,
        dryRun: opts.dryRun ?? false,
        emit: opts.emit,
      });
    });
    const router = createWorkflowRouter({ deploy });
    const runner = new WorkflowRunner(runtime, { router, logger });

    const admission = await runtime.executions.admit({
      executionId,
      workflowId: "deploy",
      params: {},
      context: new Map(),
    });
    if (admission.status === "rejected") throw new Error(admission.message);
    const [lease] = await runtime.executions.claimDue({
      limit: 1,
      duration: 60_000,
      filter: { executionIds: [executionId] },
    });
    if (!lease) throw new Error(`Execution ${executionId} is not due`);
    const outcome = await runner.run(
      { workflowId: "deploy", executionId, params: {}, context: new Map() },
      { lease, signal: new AbortController().signal },
    );
    await runtime.executions.acknowledge({ lease, outcome });
    if (outcome.status === "failed") throw outcome.error;
    return outcome;
  }

  return {
    state,
    runDeploy,
    close: () => database.close(),
  };
}

describe("drift output propagation on noop and planNotes", () => {
  let rt: ReturnType<typeof createTestRuntime>;

  beforeEach(() => {
    rt = createTestRuntime();
  });

  afterEach(() => {
    rt.close();
  });

  function defineSourceLike(readVersion: () => string) {
    return resource<{
      Key: {};
      CreateParams: { name: string };
      UpdateParams: { name: string };
      ReadResult: { version: string };
    }>({
      type: "test/secrets/Value",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
        version: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: async () => undefined,
        read: async () => ({ version: readVersion() }),
        update: async () => undefined,
        delete: async () => undefined,
      });
  }

  function defineConsumer(
    onWrite: (params: { version: string }) => void,
    planNotes?: (ctx: {
      decision: string;
      params: { version: string };
    }) => Promise<string[] | undefined> | string[] | undefined,
  ) {
    return resource<{
      Key: {};
      CreateParams: { version: string };
      UpdateParams: { version: string };
      ReadResult: {};
    }>({
      type: "test/secrets/Consumer",
      provider: "test",
    })
      .defineSchema({
        version: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        create: async (params) => {
          onWrite(params);
        },
        update: async (_key, _patch, params) => {
          onWrite(params);
        },
        delete: async () => undefined,
        planNotes,
      });
  }

  it("propagates updated output from noop drift read in createPlan so dependents plan update", async () => {
    let currentVersion = "1";
    const Source = defineSourceLike(() => currentVersion);
    const Consumer = defineConsumer(() => {});

    const state = new MemoryStateBackend({
      val: {
        version: 1,
        id: "val",
        type: Source.type,
        provider: Source.provider,
        config: { name: "k" },
        params: { name: "k" },
        output: { name: "k", version: "1" },
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
      consumer: {
        version: 1,
        id: "consumer",
        type: Consumer.type,
        provider: Consumer.provider,
        config: { version: "1" },
        params: { version: "1" },
        output: { version: "1" },
        dependsOn: ["val"],
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    // Unchanged version -> both noop
    let s = new Source("val", { config: { name: "k" } });
    let c = new Consumer("consumer", {
      config: { version: s.outputRef("version") },
    });
    let plan = await createPlan({ resources: [s, c], state });
    expect(plan.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["val", "noop"],
      ["consumer", "noop"],
    ]);

    // External version bump -> val is noop, consumer sees version "2" and plans update
    currentVersion = "2";
    s = new Source("val", { config: { name: "k" } });
    c = new Consumer("consumer", {
      config: { version: s.outputRef("version") },
    });
    plan = await createPlan({ resources: [s, c], state });
    expect(plan.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["val", "noop"],
      ["consumer", "update"],
    ]);
    expect(plan.nodes[1]?.params).toEqual({ version: "2" });
  });

  it("persists updated output on noop drift read in deploy (unless dryRun) and propagates to dependents", async () => {
    let currentVersion = "1";
    const writes: string[] = [];
    const Source = defineSourceLike(() => currentVersion);
    const Consumer = defineConsumer((p) => writes.push(p.version));

    const makeResources = () => {
      const s = new Source("val", { config: { name: "k" } });
      const c = new Consumer("consumer", {
        config: { version: s.outputRef("version") },
      });
      return [s, c];
    };

    await rt.runDeploy("deploy-1", makeResources());
    expect(writes).toEqual(["1"]);
    const valAfterCreate = await rt.state.get("val");
    expect(valAfterCreate?.output).toEqual({
      name: "k",
      version: "1",
    });

    // Dry run when version changed: propagates in memory (would update) without persisting val's output
    currentVersion = "2";
    const decisions: Array<[string, string]> = [];
    await rt.runDeploy("dry-2", makeResources(), {
      dryRun: true,
      emit: (event) => {
        if (event.event === "reconciler.deploy.decision") {
          decisions.push([event.resourceId, event.decision]);
        }
      },
    });
    expect(decisions).toEqual([
      ["val", "noop"],
      ["consumer", "update"],
    ]);
    expect(writes).toEqual(["1"]);
    expect((await rt.state.get("val"))?.output).toEqual({
      name: "k",
      version: "1",
    });

    // Real deploy persists val's updated output and updates consumer
    await rt.runDeploy("deploy-2", makeResources());
    expect(writes).toEqual(["1", "2"]);
    const valAfterBump = await rt.state.get("val");
    expect(valAfterBump?.output).toEqual({
      name: "k",
      version: "2",
    });
    expect(valAfterBump?.version).toBeGreaterThan(valAfterCreate!.version);
    expect((await rt.state.get("consumer"))?.params).toEqual({
      version: "2",
    });

    // Subsequent deploy with same version does not increment state record version
    await rt.runDeploy("deploy-3", makeResources());
    expect((await rt.state.get("val"))?.version).toBe(valAfterBump?.version);
    expect(writes).toEqual(["1", "2"]);
  });

  it("surfaces planNotes on PlanNode and omits empty/undefined notes", async () => {
    const Consumer = defineConsumer(
      () => {},
      async ({ decision }) =>
        decision === "create"
          ? ["not set; deploy will prompt for a value, or fail without a TTY"]
          : undefined,
    );
    const Plain = defineConsumer(() => {});

    const state = new MemoryStateBackend();
    const plan = await createPlan({
      resources: [
        new Consumer("secret", { config: { version: "1" } }),
        new Plain("plain", { config: { version: "1" } }),
      ],
      state,
    });

    expect(plan.nodes[0]?.notes).toEqual([
      "not set; deploy will prompt for a value, or fail without a TTY",
    ]);
    expect("notes" in plan.nodes[1]!).toBe(false);
  });

  it("refreshes alwaysRead output on update in createPlan so dependents plan update when source/key changes", async () => {
    const AlwaysReadSource = resource<{
      Key: {};
      CreateParams: { name: string };
      UpdateParams: { name: string };
      ReadResult: { version: string };
    }>({
      type: "test/secrets/AlwaysReadValue",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
        version: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
      })
      .defineOperations({
        alwaysRead: true,
        create: async () => undefined,
        read: async () => ({ version: "v2" }),
        update: async () => undefined,
        delete: async () => undefined,
      });

    const Consumer = defineConsumer(() => {});
    const state = new MemoryStateBackend({
      val: {
        version: 1,
        id: "val",
        type: AlwaysReadSource.type,
        provider: AlwaysReadSource.provider,
        config: { name: "OLD_KEY" },
        params: { name: "OLD_KEY" },
        output: { name: "OLD_KEY", version: "v1" },
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
      consumer: {
        version: 1,
        id: "consumer",
        type: Consumer.type,
        provider: Consumer.provider,
        config: { version: "v1" },
        params: { version: "v1" },
        output: { version: "v1" },
        dependsOn: ["val"],
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const s = new AlwaysReadSource("val", { config: { name: "NEW_KEY" } });
    const c = new Consumer("consumer", {
      config: { version: s.outputRef("version") },
    });
    const plan = await createPlan({ resources: [s, c], state });

    expect(plan.nodes.map((n) => [n.id, n.decision])).toEqual([
      ["val", "update"],
      ["consumer", "update"],
    ]);
    expect(plan.nodes[1]?.params).toEqual({ version: "v2" });
  });
});
