import { EventEmitter } from "node:events";
import {
  ExecutionDispatcher,
  WorkflowRunner,
  waitForExecutionOutcome,
  type ExecutionRecord,
  type WorkflowInvoker,
  type WorkflowRouter,
} from "@yieldstar/core";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import {
  DurableStateBackend,
  type DurableStep,
} from "@notation/reconciler/durable";
import pino, { type Logger } from "pino";
import { filePaths, toProjectRoot } from "src/utils/paths";
import {
  ExecutionAdmissionError,
  createWorkflowRouter,
  workflow,
} from "yieldstar";

function resolveDatabasePath(): string {
  return process.env.NOTATION_DATABASE_PATH ?? filePaths.database();
}

export function resolveDeploymentId(entryPoint: string): string {
  return toProjectRoot(entryPoint);
}

export type NodeDurableRuntimeOptions = {
  deploymentId: string;
  databasePath?: string;
  logger?: Logger;
  /**
   * How long a delivery's lease lasts unless renewed, in milliseconds. A
   * resumed execution whose process was killed waits up to this long for the
   * old lease to expire.
   */
  leaseDuration?: number;
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

/** Resident durable runtime used by Notation application commands. */
export class NodeDurableRuntime {
  readonly deploymentId: string;
  readonly state: DurableStateBackend;
  readonly #database: ReturnType<typeof createSqliteDb>;
  readonly #runtime: SqliteRuntime;
  readonly #logger: Logger;
  readonly #leaseDuration: number | undefined;
  #running = false;

  constructor(opts: NodeDurableRuntimeOptions) {
    this.deploymentId = opts.deploymentId;
    this.#logger = opts.logger ?? pino({ level: "silent" });
    this.#leaseDuration = opts.leaseDuration;
    this.#database = createSqliteDb({
      path: opts.databasePath ?? resolveDatabasePath(),
    });
    this.#runtime = new SqliteRuntime(this.#database);
    this.state = new DurableStateBackend(
      this.#runtime.stores,
      this.deploymentId,
    );
  }

  /**
   * Runs one execution until it ends and returns its result. The dispatcher
   * delivers only this execution, so this process never resumes another
   * execution in the same database against its own resources.
   */
  async run(
    router: WorkflowRouter,
    opts: RunWorkflowOptions,
  ): Promise<unknown> {
    if (this.#running) {
      throw new Error("NodeDurableRuntime is already running a workflow");
    }
    this.#running = true;
    const runner = new WorkflowRunner(this.#runtime, {
      router,
      logger: this.#logger,
    });
    const invoker: WorkflowInvoker = {
      workflowEndEmitter: new EventEmitter(),
      deliver: (event, { lease, signal }) =>
        runner.run(event, { lease, signal, logger: this.#logger }),
    };
    const dispatcher = new ExecutionDispatcher(this.#runtime, {
      invoker,
      logger: this.#logger,
      filter: { executionIds: [opts.executionId] },
      concurrency: 1,
      leaseDuration: this.#leaseDuration,
    });
    try {
      // Admission runs before the dispatcher starts, because the dispatcher
      // claims a due execution at once and would deliver one bound to
      // another workflow or deployment before the check throws.
      await this.#admit(opts);
      dispatcher.start();
      const outcome = await waitForExecutionOutcome(
        this.#runtime.executions,
        opts.executionId,
        { emitter: invoker.workflowEndEmitter },
      );
      if (!outcome) {
        throw new Error(`Execution ${opts.executionId} has no record`);
      }
      if (outcome.status === "failed") throw outcome.error;
      return outcome.result;
    } finally {
      await dispatcher.stop();
      this.#running = false;
    }
  }

  /** Reads the execution record, for reporting on a run. */
  execution(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.#runtime.executions.get(executionId);
  }

  /**
   * Admits a new execution, or checks that an existing one belongs to this
   * deployment and workflow, so a reused ID cannot replay one workflow's
   * recorded steps inside another.
   */
  async #admit({ workflowId, executionId }: RunWorkflowOptions): Promise<void> {
    const admission = await this.#runtime.executions.admit({
      executionId,
      workflowId,
      params: { deploymentId: this.deploymentId },
      context: new Map(),
    });
    if (admission.status === "accepted") return;
    if (admission.code !== "EXECUTION_ID_CONFLICT") {
      throw new ExecutionAdmissionError(admission.code, admission.message);
    }

    const record = await this.#runtime.executions.get(executionId);
    if (!record) throw new Error(admission.message);
    const deploymentId = record.params?.deploymentId;
    if (
      record.workflowId !== workflowId ||
      deploymentId !== this.deploymentId
    ) {
      throw new Error(
        `Execution ${executionId} is bound to deployment ${String(deploymentId)} workflow ${record.workflowId}, not deployment ${this.deploymentId} workflow ${workflowId}`,
      );
    }
    // A failed execution never runs again. The next run plans from persisted
    // state and skips the resources that already converged.
    if (record.outcome?.status === "failed") {
      throw new Error(
        `Execution ${executionId} failed and cannot be resumed. Run ${workflowId} again without --execution-id to start a new execution. ${record.outcome.error.message}`,
        { cause: record.outcome.error },
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
