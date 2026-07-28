import { randomUUID } from "node:crypto";
import { access, rename } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  WorkflowRunner,
  type WorkflowEvent,
  type WorkflowRouter,
} from "@yieldstar/core";
import {
  SqliteEventLoop,
  SqliteHeapClient,
  SqliteSchedulerClient,
  SqliteStoreClient,
  SqliteTaskQueueClient,
  SqliteTimersClient,
  createSqliteDb,
} from "@yieldstar/sqlite-runtime/node";
import {
  DurableStateBackend,
  resourceStateStore,
  type DurableStep,
  type StoredResourceState,
} from "@notation/reconciler/durable";
import { FileStateBackend, type StateNode } from "@notation/state";
import pino, { type Logger } from "pino";
import * as v from "valibot";
import { createWorkflowRouter, defineStore, workflow } from "yieldstar";

export const DEFAULT_WORKFLOW_STATE_PATH = ".notation/workflows.db";
export const DEFAULT_LEGACY_STATE_PATH = ".notation/state.json";

export function resolveWorkflowStatePath(): string {
  return process.env.NOTATION_STATE_PATH ?? DEFAULT_WORKFLOW_STATE_PATH;
}

export function resolveDeploymentId(entryPoint: string): string {
  return path.resolve(entryPoint);
}

export type NodeDurableRuntimeOptions = {
  deploymentId: string;
  databasePath?: string;
  legacyStatePath?: string | false;
  logger?: Logger;
};

export type RunWorkflowOptions = {
  workflowId: string;
  executionId?: string;
  params?: Record<string, unknown>;
};

const executionBindingStore = defineStore(
  "notation/execution-binding",
  v.object({ deploymentId: v.string(), workflowId: v.string() }),
);

type ExecutionBinding = v.InferOutput<typeof executionBindingStore.schema>;

/** Resident Yieldstar Node runtime used by Notation application commands. */
export class NodeDurableRuntime {
  readonly deploymentId: string;
  readonly state: DurableStateBackend;
  readonly #database: ReturnType<typeof createSqliteDb>;
  readonly #eventLoop: SqliteEventLoop;
  readonly #heapClient: SqliteHeapClient;
  readonly #schedulerClient: SqliteSchedulerClient;
  readonly #storeClient: SqliteStoreClient;
  readonly #logger: Logger;
  readonly #legacyStatePath: string | undefined;
  #running = false;

  constructor(opts: NodeDurableRuntimeOptions) {
    this.deploymentId = opts.deploymentId;
    this.#logger = opts.logger ?? pino({ level: "silent" });
    const databasePath = opts.databasePath ?? resolveWorkflowStatePath();
    this.#legacyStatePath =
      opts.legacyStatePath === false
        ? undefined
        : (opts.legacyStatePath ??
          (databasePath === DEFAULT_WORKFLOW_STATE_PATH
            ? DEFAULT_LEGACY_STATE_PATH
            : undefined));
    this.#database = createSqliteDb({
      path: databasePath,
    });
    const taskQueueClient = new SqliteTaskQueueClient(this.#database);
    this.#schedulerClient = new SqliteSchedulerClient({
      taskQueueClient,
      timersClient: new SqliteTimersClient(this.#database),
    });
    this.#storeClient = new SqliteStoreClient({
      db: this.#database,
      schedulerClient: this.#schedulerClient,
    });
    this.#heapClient = new SqliteHeapClient(this.#database);
    this.#eventLoop = new SqliteEventLoop(this.#database);
    this.state = new DurableStateBackend(this.#storeClient, this.deploymentId);
  }

  async run(
    router: WorkflowRouter,
    opts: RunWorkflowOptions,
  ): Promise<unknown> {
    if (this.#running) {
      throw new Error(
        "The Node Yieldstar runtime already has an active workflow",
      );
    }
    this.#running = true;
    try {
      const executionId = opts.executionId ?? randomUUID();
      const runner = new WorkflowRunner({
        router,
        heapClient: this.#heapClient,
        storeClient: this.#storeClient,
        schedulerClient: this.#schedulerClient,
        logger: this.#logger,
      });

      await this.initialize();
      await this.#bindExecution(executionId, opts.workflowId);
      const result = await this.#driveToCompletion(runner, {
        workflowId: opts.workflowId,
        executionId,
        params: opts.params ?? {},
        context: new Map(),
      });
      // Let the queue transaction finish before callers close the shared database.
      await setImmediate();
      return result;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Runs one execution to completion in-process: the trigger event directly,
   * then every event the queue produces for it (retries, timer wake-ups),
   * polling timers between rounds. Tasks queued for other executions are
   * hidden for the duration and made visible again on the way out, so this
   * runner never resumes an execution it was not asked to run.
   *
   * This loop exists because Yieldstar's own SqliteEventLoop is a resident
   * server: it runs until stopped, serves every execution in the queue, and
   * never says when one is done — none of which fits a command that must run
   * exactly its own execution and then exit.
   */
  async #driveToCompletion(
    runner: WorkflowRunner<WorkflowRouter>,
    event: WorkflowEvent,
  ): Promise<unknown> {
    const deferredTaskIds: number[] = [];
    try {
      let outcome = await runner.run(event, this.#logger);
      while (!outcome) {
        const task = this.#eventLoop.taskQueue.process();
        if (!task) {
          this.#eventLoop.timers.processTimers();
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (task.event.executionId !== event.executionId) {
          deferredTaskIds.push(task.taskId);
          continue;
        }
        try {
          await this.#bindExecution(
            task.event.executionId,
            task.event.workflowId,
          );
          outcome = await runner.run(task.event, this.#logger);
        } finally {
          this.#eventLoop.taskQueue.remove(task.taskId);
        }
      }
      return outcome.result;
    } finally {
      for (const taskId of deferredTaskIds) {
        this.#eventLoop.taskQueue.makeVisible(taskId);
      }
    }
  }

  /**
   * Prepares the deployment database for use — today that means importing
   * legacy `.notation/state.json` state on first contact. `run` calls this
   * itself; read-only consumers (plan, dashboard) call it before reading so
   * they see migrated state too.
   */
  async initialize(): Promise<void> {
    await this.#migrateLegacyState();
  }

  async #bindExecution(executionId: string, workflowId: string): Promise<void> {
    const expected: ExecutionBinding = {
      deploymentId: this.deploymentId,
      workflowId,
    };
    const binding = await this.#storeClient.getOrCreateStore({
      definition: executionBindingStore,
      id: executionId,
      initial: expected,
    });
    const existing: ExecutionBinding = binding.state;
    if (!isDeepStrictEqual(existing, expected)) {
      throw new Error(
        `Yieldstar execution ${executionId} is bound to deployment ${existing.deploymentId} workflow ${existing.workflowId}, not deployment ${this.deploymentId} workflow ${workflowId}`,
      );
    }
  }

  async #migrateLegacyState(): Promise<void> {
    const legacyStatePath = this.#legacyStatePath;
    if (!legacyStatePath) return;
    try {
      await access(legacyStatePath);
    } catch {
      return;
    }

    const legacyState = await new FileStateBackend(legacyStatePath).values();
    const durableState = await this.state.values();
    const legacyById = new Map(legacyState.map((node) => [node.id, node]));

    // Every durable record must match its legacy counterpart exactly; one
    // that is missing from the legacy file, or that differs, means the two
    // stores have diverged and neither can be trusted as the source.
    for (const current of durableState) {
      const legacy = legacyById.get(current.id);
      if (!legacy || !statesMatchIgnoringRevision(current, legacy)) {
        throw legacyMigrationConflict(legacyStatePath);
      }
    }

    // Import only the legacy records the durable store lacks: any shared
    // record was verified identical above.
    const durableIds = new Set(durableState.map((node) => node.id));
    for (const node of legacyState) {
      if (durableIds.has(node.id)) continue;
      const { rev: _rev, ...state } = node;
      await this.#storeClient.getOrCreateStore({
        definition: resourceStateStore,
        id: this.state.storeId(node.id),
        // Legacy records predate group metadata; -1 and "" are
        // BaseResource's defaults for a resource that belongs to no group.
        initial: { groupId: -1, groupType: "", ...state } as StoredResourceState,
      });
    }
    await rename(legacyStatePath, `${legacyStatePath}.migrated`);
  }

  close(): void {
    if (this.#running) {
      throw new Error(
        "Cannot close the Node Yieldstar runtime while a workflow is active",
      );
    }
    this.#database.close();
  }
}

/**
 * Runs `fn` with a Node runtime for the entry point's deployment, creating one
 * when the caller did not supply a runtime and closing it again afterwards. A
 * supplied runtime stays open: its lifecycle belongs to the caller.
 */
export async function withRuntime<T>(
  opts: {
    entryPoint: string;
    runtime?: NodeDurableRuntime;
    databasePath?: string;
  },
  fn: (runtime: NodeDurableRuntime) => Promise<T>,
): Promise<T> {
  const runtime =
    opts.runtime ??
    new NodeDurableRuntime({
      deploymentId: resolveDeploymentId(opts.entryPoint),
      databasePath: opts.databasePath,
    });
  try {
    return await fn(runtime);
  } finally {
    if (!opts.runtime) runtime.close();
  }
}

/**
 * Wraps a reconciler generator as a single-workflow router and runs it to
 * completion on the entry point's runtime. This is the cutover pattern shared
 * by every mutating command: one command, one workflow, one execution.
 */
export async function runDurableWorkflow(
  opts: {
    entryPoint: string;
    workflowId: string;
    runtime?: NodeDurableRuntime;
    databasePath?: string;
    executionId?: string;
  },
  body: (
    step: DurableStep,
    executionId: string,
    runtime: NodeDurableRuntime,
  ) => AsyncGenerator<any, void, any>,
): Promise<void> {
  await withRuntime(opts, async (runtime) => {
    const handler = workflow(async function* (step, event) {
      yield* body(step, event.executionId, runtime);
    });
    await runtime.run(createWorkflowRouter({ [opts.workflowId]: handler }), {
      workflowId: opts.workflowId,
      executionId: opts.executionId,
    });
  });
}

function statesMatchIgnoringRevision(left: StateNode, right: StateNode) {
  const { rev: _leftRev, ...leftState } = left;
  const { rev: _rightRev, ...rightState } = right;
  return isDeepStrictEqual(leftState, rightState);
}

function legacyMigrationConflict(legacyStatePath: string) {
  return new Error(
    `Cannot migrate legacy state from ${legacyStatePath} because the durable database already contains different resource state. Back up both files, then remove the new durable database and retry the command to import the legacy state.`,
  );
}
