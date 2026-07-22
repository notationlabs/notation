import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as reconciler from "@notation/reconciler";
import { resource } from "@notation/resource";
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
            const error = new Error("provider is pending");
            error.name = "ProviderPending";
            throw error;
          }
        },
        delete: async () => undefined,
        retryLaterOnError: [
          { name: "ProviderPending", reason: "provider is pending" },
        ],
      });
    const resources = [new PendingResource({ id: "pending" })];
    const deploy = workflow(async function* (step, event) {
      yield* reconciler.deploy(step, {
        deploymentId: runtime.deploymentId,
        executionId: event.executionId,
        resources,
        state: runtime.state,
        driftDetection: false,
        retryOptions: { maxAttempts: 3, retryInterval: 10 },
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

  it("imports and archives legacy JSON state before running", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-migrate-"));
    const databasePath = path.join(directory, "workflows.db");
    const legacyStatePath = path.join(directory, "state.json");
    await writeFile(
      legacyStatePath,
      JSON.stringify({
        existing: {
          rev: 7,
          id: "existing",
          type: "test/legacy",
          config: {},
          params: {},
          output: { remoteId: "provider-123" },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      }),
    );
    const runtime = new NodeDurableRuntime({
      deploymentId: "legacy-deployment",
      databasePath,
      legacyStatePath,
    });
    const completed = workflow(async function* () {});

    try {
      await runtime.run(createWorkflowRouter({ deploy: completed }), {
        workflowId: "deploy",
        executionId: "migration-execution",
      });
      await expect(runtime.state.get("existing")).resolves.toMatchObject({
        output: { remoteId: "provider-123" },
      });
      await expect(access(legacyStatePath)).rejects.toThrow();
      await expect(
        access(`${legacyStatePath}.migrated`),
      ).resolves.toBeUndefined();
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalises equivalent entry-point spellings", () => {
    const absolute = path.resolve("infra/api.ts");
    expect(resolveDeploymentId("infra/api.ts")).toBe(absolute);
    expect(resolveDeploymentId("./infra/api.ts")).toBe(absolute);
    expect(resolveDeploymentId(absolute)).toBe(absolute);
  });
});
