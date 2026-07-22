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
import { DurableStateBackend } from "@notation/reconciler";
import { FileStateBackend, type StateNode } from "@notation/state";
import pino, { type Logger } from "pino";
import { defineStore } from "yieldstar";

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

type ExecutionBinding = {
  deploymentId: string;
  workflowId: string;
};

const executionBindingStore = defineStore("notation/execution-binding", {
  "~standard": {
    version: 1 as const,
    vendor: "notation",
    validate(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        "deploymentId" in value &&
        typeof value.deploymentId === "string" &&
        "workflowId" in value &&
        typeof value.workflowId === "string"
      ) {
        return { value: value as ExecutionBinding };
      }
      return { issues: [{ message: "Execution binding is invalid" }] };
    },
  },
});

/** Resident Yieldstar 0.5.0 Node runtime used by Notation application commands. */
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
    const executionId = opts.executionId ?? randomUUID();
    const event: WorkflowEvent = {
      workflowId: opts.workflowId,
      executionId,
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
    let completed = false;
    const completion = new Promise<unknown>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const processEvent = async (nextEvent: WorkflowEvent, logger: Logger) => {
      try {
        const result = await runner.run(nextEvent, logger);
        if (result && nextEvent.executionId === event.executionId) {
          completed = true;
          resolveCompletion(result.result);
        }
      } catch (error) {
        if (nextEvent.executionId === event.executionId) {
          completed = true;
          rejectCompletion(error);
          return;
        }
        this.#logger.error({ err: error }, "Yieldstar replay failed");
      }
    };

    try {
      await this.initialize();
      await this.#bindExecution(executionId, opts.workflowId);
      await processEvent(event, this.#logger);
      const eventPump = this.#processQueuedEvents(
        executionId,
        processEvent,
        rejectCompletion,
        () => completed,
      );
      try {
        return await completion;
      } finally {
        await eventPump;
        // Let the queue transaction finish before callers close the shared database.
        await setImmediate();
      }
    } finally {
      this.#running = false;
    }
  }

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
    const existing = binding.state as ExecutionBinding;
    if (!isDeepStrictEqual(existing, expected)) {
      throw new Error(
        `Yieldstar execution ${executionId} is bound to deployment ${existing.deploymentId} workflow ${existing.workflowId}, not deployment ${this.deploymentId} workflow ${workflowId}`,
      );
    }
  }

  async #processQueuedEvents(
    executionId: string,
    processEvent: (event: WorkflowEvent, logger: Logger) => Promise<void>,
    rejectCompletion: (error: unknown) => void,
    isCompleted: () => boolean,
  ): Promise<void> {
    const deferredTaskIds: number[] = [];
    try {
      while (this.#running && !isCompleted()) {
        let task = this.#eventLoop.taskQueue.process();
        while (task) {
          if (task.event.executionId !== executionId) {
            deferredTaskIds.push(task.taskId);
          } else {
            try {
              await this.#bindExecution(
                task.event.executionId,
                task.event.workflowId,
              );
              await processEvent(task.event, this.#logger);
            } finally {
              this.#eventLoop.taskQueue.remove(task.taskId);
            }
          }
          if (!this.#running || isCompleted()) return;
          task = this.#eventLoop.taskQueue.process();
        }
        this.#eventLoop.timers.processTimers();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      rejectCompletion(error);
    } finally {
      for (const taskId of deferredTaskIds) {
        this.#eventLoop.taskQueue.makeVisible(taskId);
      }
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
    for (const current of durableState) {
      const legacy = legacyById.get(current.id);
      if (!legacy || !statesMatchIgnoringRevision(current, legacy)) {
        throw legacyMigrationConflict(legacyStatePath);
      }
    }
    for (const node of legacyState) {
      const current = await this.state.get(node.id);
      if (!current) {
        await this.state.update(node.id, 0, node);
      } else if (!statesMatchIgnoringRevision(current, node)) {
        throw legacyMigrationConflict(legacyStatePath);
      }
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
