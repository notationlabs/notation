import {
  REDELIVERY_DELAY_BASE,
  WorkflowRunner,
  type HeapClient,
  type Runtime,
} from "@notation/durable/runtime";
import { SqliteRuntime, createSqliteDb } from "@notation/durable/sqlite/node";
import { createWorkflowRouter, workflow } from "@notation/durable";
import type { BaseResource } from "@notation/resource";
import pino from "pino";
import { clearHeldCredentials } from "../src/credentials";
import * as durable from "../src/durable";
import type { ReconcilerEvent } from "../src/events";
import type { DeployRequest } from "../src/deploy-request";

class CrashAfterWriteHeap implements HeapClient {
  #crashed = false;

  constructor(
    private readonly inner: HeapClient,
    private readonly crashAfterStep: string,
  ) {}

  readStep(params: { executionId: string; stepKey: string }) {
    return this.inner.readStep(params);
  }

  recordCancellation(params: Parameters<HeapClient["recordCancellation"]>[0]) {
    return this.inner.recordCancellation(params);
  }

  async writeStep(params: Parameters<HeapClient["writeStep"]>[0]) {
    const result = await this.inner.writeStep(params);
    if (
      !this.#crashed &&
      params.stepKey === this.crashAfterStep &&
      params.done
    ) {
      this.#crashed = true;
      throw new Error("simulated process crash");
    }
    return result;
  }
}

/**
 * A durable runtime in memory, for tests of credentials. Each deploy runs as
 * the deploy of the app `shop` to the stage `prod`.
 */
export function createRuntime(
  options: { crashAfterStep?: string; driftDetection?: boolean } = {},
) {
  const database = createSqliteDb({ path: ":memory:" });
  let skew = 0;
  const sqliteRuntime = new SqliteRuntime(database, {
    clock: () => Date.now() + skew,
  });
  const runtime: Runtime = {
    clock: sqliteRuntime.clock,
    executions: sqliteRuntime.executions,
    effects: sqliteRuntime.effects,
    heap: options.crashAfterStep
      ? new CrashAfterWriteHeap(sqliteRuntime.heap, options.crashAfterStep)
      : sqliteRuntime.heap,
    stores: sqliteRuntime.stores,
    joins: sqliteRuntime.joins,
  };
  const state = new durable.DurableStateBackend(
    sqliteRuntime.stores,
    "credentials",
  );
  let resources: BaseResource[] = [];
  let requested: DeployRequest | undefined;
  const events: ReconcilerEvent[] = [];
  const router = createWorkflowRouter({
    deploy: workflow(async function* (step, event) {
      yield* durable.deploy(step, {
        executionId: event.executionId,
        resources,
        state,
        driftDetection: options.driftDetection ?? false,
        nameScope: { app: "shop", stage: "prod" },
        requested,
        emit: (event) => {
          events.push(event);
        },
      });
    }),
  });
  const runner = new WorkflowRunner(runtime, {
    router,
    logger: pino({ level: "silent" }),
  });

  async function deploy(
    executionId: string,
    declared: BaseResource[],
    request?: DeployRequest,
  ) {
    resources = declared;
    requested = request;
    if (!(await runtime.executions.get(executionId))) {
      const admission = await runtime.executions.admit({
        executionId,
        workflowId: "deploy",
        params: {},
        context: new Map(),
      });
      if (admission.status === "rejected") throw new Error(admission.message);
    }
    const [lease] = await runtime.executions.claimDue({
      limit: 1,
      duration: 60_000,
      filter: { executionIds: [executionId] },
    });
    if (!lease) throw new Error(`Execution ${executionId} is not due`);
    let outcome;
    try {
      outcome = await runner.run(
        { workflowId: "deploy", executionId, params: {}, context: new Map() },
        { lease, signal: new AbortController().signal },
      );
    } catch (error) {
      await runtime.executions.release({ lease });
      skew += REDELIVERY_DELAY_BASE;
      throw error;
    }
    await runtime.executions.acknowledge({ lease, outcome });
    if (outcome.status === "failed") throw outcome.error;
    return outcome;
  }

  return {
    state,
    events,
    deploy,
    /** Deploys as a new process does, which holds no credential. */
    nextProcess(
      executionId: string,
      declared: BaseResource[],
      request?: DeployRequest,
    ) {
      clearHeldCredentials();
      return deploy(executionId, declared, request);
    },
    /** Every row of every table, as text. */
    dump(): string {
      const tables = database
        .query<{ name: string }>(
          "select name from sqlite_master where type = 'table'",
        )
        .all();
      return tables
        .map(({ name }) =>
          JSON.stringify(
            database.query(`select * from "${name}"`).all(),
            (_key, value) =>
              value instanceof Uint8Array
                ? Buffer.from(value).toString("utf8")
                : typeof value === "bigint"
                  ? String(value)
                  : value,
          ),
        )
        .join("\n");
    },
    close() {
      database.close();
    },
  };
}
