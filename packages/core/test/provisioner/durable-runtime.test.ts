import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as durable from "@notation/reconciler/durable";
import {
  ResourceOperationPendingError,
  resource,
} from "@notation/resource";
import {
  SqliteEventLoop,
  SqliteTaskQueueClient,
  createSqliteDb,
} from "@yieldstar/sqlite-runtime/node";
import { RetryableError, createWorkflowRouter, workflow } from "yieldstar";
import { describe, expect, it } from "vitest";
import {
  NodeDurableRuntime,
  resolveDeploymentId,
} from "src/provisioner/durable-runtime";

describe("NodeDurableRuntime", () => {
  it("stays resident across a provider delay and resumes from the SQLite event loop", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-runtime-"));
    const runtime = new NodeDurableRuntime({
      deploymentId: "resident-wait",
      databasePath: path.join(directory, "workflows.db"),
    });
    let attempts = 0;
    const PendingResource = resource({ type: "test/runtime/pending" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ResourceOperationPendingError("provider is not ready", {
              retryAfterMs: 10,
            });
          }
        },
        delete: async () => undefined,
      });
    const resources = [new PendingResource({ id: "pending" })];
    const deploy = workflow(async function* (step, event) {
      yield* durable.deploy(step, {
        executionId: event.executionId,
        resources,
        state: runtime.state,
        driftDetection: false,
        maxOperationAttempts: 3,
      });
    });

    try {
      await runtime.run(createWorkflowRouter({ deploy }), {
        workflowId: "deploy",
        executionId: "resident-execution",
      });
      expect(attempts).toBe(2);
      await expect(runtime.state.get("pending")).resolves.toMatchObject({
        lastOperation: "create",
      });
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 5_000);

  it("resumes an interrupted execution from a new runtime on the same database", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-resume-"));
    const databasePath = path.join(directory, "workflows.db");
    let creates = 0;
    const TestResource = resource({ type: "test/runtime/resume" })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          creates += 1;
        },
        delete: async () => undefined,
      });
    const interrupted = new TestResource({ id: "interrupted" });
    // The failure has to live in plain generator code, after the create step
    // is checkpointed but before state is persisted: a failing step would be
    // cached and rethrown on replay. A resource with no persisted state first
    // sets its output straight after create returns.
    const setOutput = interrupted.setOutput.bind(interrupted);
    let failSetOutput = true;
    interrupted.setOutput = (output) => {
      if (failSetOutput) throw new Error("simulated process crash");
      return setOutput(output);
    };
    const runDeploy = async () => {
      const runtime = new NodeDurableRuntime({
        deploymentId: "resume-deployment",
        databasePath,
      });
      const deploy = workflow(async function* (step, event) {
        yield* durable.deploy(step, {
          executionId: event.executionId,
          resources: [interrupted],
          state: runtime.state,
          driftDetection: false,
        });
      });
      try {
        await runtime.run(createWorkflowRouter({ deploy }), {
          workflowId: "deploy",
          executionId: "resumed-execution",
        });
        return await runtime.state.get("interrupted");
      } finally {
        runtime.close();
      }
    };

    try {
      await expect(runDeploy()).rejects.toThrow("simulated process crash");
      expect(creates).toBe(1);

      failSetOutput = false;
      await expect(runDeploy()).resolves.toMatchObject({
        id: "interrupted",
        lastOperation: "create",
      });
      // The provider call was replayed from the heap, not repeated.
      expect(creates).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds an execution ID to its deployment and workflow", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-binding-"));
    const databasePath = path.join(directory, "workflows.db");
    const completed = workflow(async function* () {});
    const router = createWorkflowRouter({
      deploy: completed,
      destroy: completed,
    });
    const first = new NodeDurableRuntime({
      deploymentId: "first-deployment",
      databasePath,
    });

    try {
      await first.run(router, {
        workflowId: "deploy",
        executionId: "bound-execution",
      });
      await expect(
        first.run(router, {
          workflowId: "destroy",
          executionId: "bound-execution",
        }),
      ).rejects.toThrow("bound to deployment first-deployment workflow deploy");
    } finally {
      first.close();
    }

    const second = new NodeDurableRuntime({
      deploymentId: "second-deployment",
      databasePath,
    });
    try {
      await expect(
        second.run(router, {
          workflowId: "deploy",
          executionId: "bound-execution",
        }),
      ).rejects.toThrow("bound to deployment first-deployment workflow deploy");
    } finally {
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not acknowledge queued events from another execution", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-queue-"));
    const databasePath = path.join(directory, "workflows.db");
    const database = createSqliteDb({ path: databasePath });
    new SqliteEventLoop(database);
    new SqliteTaskQueueClient(database).add({
      workflowId: "deploy",
      executionId: "unrelated-execution",
      params: {},
      context: new Map(),
    });
    database.close();

    let attempts = 0;
    const delayed = workflow(async function* (step) {
      yield* step.run("delay", async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RetryableError("not ready", {
            maxAttempts: 2,
            retryInterval: 10,
          });
        }
      });
    });
    const runtime = new NodeDurableRuntime({
      deploymentId: "queue-test",
      databasePath,
    });
    try {
      await runtime.run(createWorkflowRouter({ deploy: delayed }), {
        workflowId: "deploy",
        executionId: "current-execution",
      });
    } finally {
      runtime.close();
    }

    const reopened = createSqliteDb({ path: databasePath });
    const queued = new SqliteEventLoop(reopened).taskQueue.process();
    expect(queued?.event.executionId).toBe("unrelated-execution");
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }, 5_000);

  it("canonicalises equivalent entry-point spellings", () => {
    const absolute = path.resolve("infra/api.ts");
    expect(resolveDeploymentId("infra/api.ts")).toBe(absolute);
    expect(resolveDeploymentId("./infra/api.ts")).toBe(absolute);
    expect(resolveDeploymentId(absolute)).toBe(absolute);
  });
});
