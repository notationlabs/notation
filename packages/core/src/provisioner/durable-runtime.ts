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
  type DurableStep,
} from "@notation/reconciler/durable";
import pino, { type Logger } from "pino";
import * as v from "valibot";
import { createWorkflowRouter, defineStore, workflow } from "yieldstar";

const DEFAULT_DATABASE_PATH = ".notation/workflows.db";

function resolveDatabasePath(): string {
  return process.env.NOTATION_DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
}

export function resolveDeploymentId(entryPoint: string): string {
  return path.resolve(entryPoint);
}

export type NodeDurableRuntimeOptions = {
  deploymentId: string;
  databasePath?: string;
  logger?: Logger;
};

/**
 * The execution ID is required rather than defaulted: it is the handle for
 * resuming a crashed execution, so the caller that starts a run must already
 * hold it. Generation belongs to the outermost caller (e.g. the CLI, which
 * prints the ID before any provider work).
 */
export type RunWorkflowOptions = {
  workflowId: string;
  executionId: string;
};

const executionBindingStore = defineStore(
  "notation/execution-binding",
  v.object({ deploymentId: v.string(), workflowId: v.string() }),
);

type ExecutionBinding = v.InferOutput<typeof executionBindingStore.schema>;

/** Resident durable runtime used by Notation application commands. */
export class NodeDurableRuntime {
  readonly deploymentId: string;
  readonly state: DurableStateBackend;
  readonly #database: ReturnType<typeof createSqliteDb>;
  readonly #eventLoop: SqliteEventLoop;
  readonly #heapClient: SqliteHeapClient;
  readonly #schedulerClient: SqliteSchedulerClient;
  readonly #storeClient: SqliteStoreClient;
  readonly #logger: Logger;
  #running = false;

  constructor(opts: NodeDurableRuntimeOptions) {
    this.deploymentId = opts.deploymentId;
    this.#logger = opts.logger ?? pino({ level: "silent" });
    this.#database = createSqliteDb({
      path: opts.databasePath ?? resolveDatabasePath(),
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
      throw new Error("NodeDurableRuntime is already running a workflow");
    }
    this.#running = true;
    try {
      const { executionId } = opts;
      const runner = new WorkflowRunner({
        router,
        heapClient: this.#heapClient,
        storeClient: this.#storeClient,
        schedulerClient: this.#schedulerClient,
        logger: this.#logger,
      });

      await this.#bindExecution(executionId, opts.workflowId);
      const result = await this.#driveToCompletion(runner, {
        workflowId: opts.workflowId,
        executionId,
        params: {},
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
   * Pins an execution ID to its deployment and workflow on first use, so a
   * reused ID cannot replay one workflow's cached steps inside another.
   */
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
        `Execution ${executionId} is bound to deployment ${existing.deploymentId} workflow ${existing.workflowId}, not deployment ${this.deploymentId} workflow ${workflowId}`,
      );
    }
  }

  close(): void {
    if (this.#running) {
      throw new Error(
        "Cannot close NodeDurableRuntime while a workflow is running",
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
  if (opts.runtime && opts.databasePath) {
    throw new Error(
      "Pass either runtime or databasePath, not both: a runtime already owns its database",
    );
  }
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
 * completion on the entry point's runtime: one command, one workflow, one
 * execution.
 */
export async function runDurableWorkflow(
  opts: {
    entryPoint: string;
    workflowId: string;
    runtime?: NodeDurableRuntime;
    databasePath?: string;
    executionId: string;
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
