import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
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
import { YieldStarStateBackend } from "@notation/reconciler";
import pino, { type Logger } from "pino";

export const DEFAULT_WORKFLOW_STATE_PATH = ".notation/workflows.db";

export function resolveWorkflowStatePath(): string {
  return process.env.NOTATION_STATE_PATH ?? DEFAULT_WORKFLOW_STATE_PATH;
}

export type NodeYieldStarRuntimeOptions = {
  deploymentId: string;
  databasePath?: string;
  logger?: Logger;
};

export type RunWorkflowOptions = {
  workflowId: string;
  executionId?: string;
  params?: Record<string, unknown>;
};

/** Resident YieldStar 0.5.0 Node runtime used by Notation application commands. */
export class NodeYieldStarRuntime {
  readonly deploymentId: string;
  readonly state: YieldStarStateBackend;
  readonly #database: ReturnType<typeof createSqliteDb>;
  readonly #eventLoop: SqliteEventLoop;
  readonly #heapClient: SqliteHeapClient;
  readonly #schedulerClient: SqliteSchedulerClient;
  readonly #storeClient: SqliteStoreClient;
  readonly #logger: Logger;
  #running = false;

  constructor(opts: NodeYieldStarRuntimeOptions) {
    this.deploymentId = opts.deploymentId;
    this.#logger = opts.logger ?? pino({ level: "silent" });
    this.#database = createSqliteDb({
      path: opts.databasePath ?? resolveWorkflowStatePath(),
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
    this.state = new YieldStarStateBackend(
      this.#storeClient,
      this.deploymentId,
    );
  }

  async run(
    router: WorkflowRouter,
    opts: RunWorkflowOptions,
  ): Promise<unknown> {
    if (this.#running) {
      throw new Error(
        "The Node YieldStar runtime already has an active workflow",
      );
    }
    this.#running = true;
    const event: WorkflowEvent = {
      workflowId: opts.workflowId,
      executionId: opts.executionId ?? randomUUID(),
      params: opts.params ?? {},
      context: new Map(),
    };
    const runner = new WorkflowRunner({
      router,
      heapClient: this.#heapClient,
      storeClient: this.#storeClient,
      schedulerClient: this.#schedulerClient,
      logger: this.#logger,
    });

    let resolveCompletion!: (value: unknown) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<unknown>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const processEvent = async (nextEvent: WorkflowEvent, logger: Logger) => {
      try {
        const result = await runner.run(nextEvent, logger);
        if (result && nextEvent.executionId === event.executionId) {
          this.#eventLoop.stop();
          resolveCompletion(result.result);
        }
      } catch (error) {
        if (nextEvent.executionId === event.executionId) {
          this.#eventLoop.stop();
          rejectCompletion(error);
          return;
        }
        this.#logger.error({ err: error }, "YieldStar replay failed");
      }
    };

    try {
      await processEvent(event, this.#logger);
      this.#eventLoop.start({ onNewEvent: processEvent, logger: this.#logger });
      try {
        return await completion;
      } finally {
        // Let SqliteEventLoop remove the completed queue item before callers
        // close the shared database.
        await setImmediate();
      }
    } finally {
      this.#eventLoop.stop();
      this.#running = false;
    }
  }

  close(): void {
    if (this.#running) {
      throw new Error(
        "Cannot close the Node YieldStar runtime while a workflow is active",
      );
    }
    this.#eventLoop.stop();
    this.#database.close();
  }
}
