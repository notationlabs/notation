import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as durable from "@notation/reconciler/durable";
import { ResourceOperationPendingError, resource } from "@notation/resource";
import { WorkflowRunner } from "@yieldstar/core";
import { SqliteRuntime, createSqliteDb } from "@yieldstar/sqlite-runtime/node";
import pino from "pino";
import { createWorkflowRouter, workflow } from "yieldstar";
import { describe, expect, it } from "vitest";
import {
  NodeDurableRuntime,
  resolveDeploymentId,
} from "src/provisioner/durable-runtime";

describe("NodeDurableRuntime", () => {
  it("stays resident across a provider delay and resumes the execution", async () => {
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
    const resources = [new PendingResource("pending")];
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
    const interrupted = new TestResource("interrupted");
    const deployWorkflow = (state: durable.DurableStateBackend) =>
      workflow(async function* (step, event) {
        yield* durable.deploy(step, {
          executionId: event.executionId,
          resources: [interrupted],
          state,
          driftDetection: false,
        });
      });

    try {
      // The first process records the provider call and then dies, which
      // leaves its lease in place until the lease expires.
      const database = createSqliteDb({ path: databasePath });
      const crashed = new SqliteRuntime(database);
      const runner = new WorkflowRunner(crashed, {
        router: createWorkflowRouter({
          deploy: deployWorkflow(
            new durable.DurableStateBackend(
              crashed.stores,
              "resume-deployment",
            ),
          ),
        }),
        logger: pino({ level: "silent" }),
      });
      await crashed.executions.admit({
        executionId: "resumed-execution",
        workflowId: "deploy",
        params: { deploymentId: "resume-deployment" },
        context: new Map(),
      });
      const [lease] = await crashed.executions.claimDue({
        limit: 1,
        duration: 100,
        filter: { executionIds: ["resumed-execution"] },
      });
      const controller = new AbortController();
      const setOutput = interrupted.setOutput.bind(interrupted);
      interrupted.setOutput = (output) => {
        controller.abort(new Error("simulated process crash"));
        return setOutput(output);
      };
      await expect(
        runner.run(
          {
            workflowId: "deploy",
            executionId: "resumed-execution",
            params: { deploymentId: "resume-deployment" },
            context: new Map(),
          },
          { lease: lease!, signal: controller.signal },
        ),
      ).rejects.toThrow("simulated process crash");
      database.close();
      interrupted.setOutput = setOutput;
      expect(creates).toBe(1);

      const runtime = new NodeDurableRuntime({
        deploymentId: "resume-deployment",
        databasePath,
      });
      try {
        await runtime.run(
          createWorkflowRouter({ deploy: deployWorkflow(runtime.state) }),
          { workflowId: "deploy", executionId: "resumed-execution" },
        );
        await expect(runtime.state.get("interrupted")).resolves.toMatchObject({
          id: "interrupted",
          lastOperation: "create",
        });
      } finally {
        runtime.close();
      }
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
      await expect(first.execution("bound-execution")).resolves.toMatchObject({
        workflowId: "deploy",
        params: { deploymentId: "first-deployment" },
        status: "completed",
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

  it("does not deliver a due execution that is bound to another deployment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-due-"));
    const databasePath = path.join(directory, "workflows.db");
    const database = createSqliteDb({ path: databasePath });
    await new SqliteRuntime(database).executions.admit({
      executionId: "due-execution",
      workflowId: "deploy",
      params: { deploymentId: "first-deployment" },
      context: new Map(),
    });
    database.close();

    const delivered: string[] = [];
    const deploy = workflow(async function* (_step, event) {
      delivered.push(event.executionId);
    });
    const runtime = new NodeDurableRuntime({
      deploymentId: "second-deployment",
      databasePath,
    });
    try {
      await expect(
        runtime.run(createWorkflowRouter({ deploy }), {
          workflowId: "deploy",
          executionId: "due-execution",
        }),
      ).rejects.toThrow("bound to deployment first-deployment workflow deploy");
      expect(delivered).toEqual([]);
      await expect(runtime.execution("due-execution")).resolves.toMatchObject({
        status: "admitted",
      });
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not deliver another execution that is ready to run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-filter-"));
    const databasePath = path.join(directory, "workflows.db");
    const database = createSqliteDb({ path: databasePath });
    await new SqliteRuntime(database).executions.admit({
      executionId: "unrelated-execution",
      workflowId: "deploy",
      params: { deploymentId: "filter-test" },
      context: new Map(),
    });
    database.close();

    const delivered: string[] = [];
    const deploy = workflow(async function* (_step, event) {
      delivered.push(event.executionId);
    });
    const runtime = new NodeDurableRuntime({
      deploymentId: "filter-test",
      databasePath,
    });
    try {
      await runtime.run(createWorkflowRouter({ deploy }), {
        workflowId: "deploy",
        executionId: "current-execution",
      });
      expect(delivered).toEqual(["current-execution"]);
      await expect(
        runtime.execution("unrelated-execution"),
      ).resolves.toMatchObject({ status: "admitted" });
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rethrows the recorded error when a failed execution is resumed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-failed-"));
    let runs = 0;
    const deploy = workflow(async function* () {
      runs += 1;
      throw new Error("provider rejected the change");
    });
    const router = createWorkflowRouter({ deploy });
    const runtime = new NodeDurableRuntime({
      deploymentId: "failed-test",
      databasePath: path.join(directory, "workflows.db"),
    });
    try {
      await expect(
        runtime.run(router, {
          workflowId: "deploy",
          executionId: "failed-execution",
        }),
      ).rejects.toThrow("provider rejected the change");

      const resumed = runtime.run(router, {
        workflowId: "deploy",
        executionId: "failed-execution",
      });
      await expect(resumed).rejects.toThrow("cannot be resumed");
      await expect(resumed).rejects.toMatchObject({
        cause: { message: "provider rejected the change" },
      });
      expect(runs).toBe(1);
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns when a completed execution is resumed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "notation-done-"));
    let runs = 0;
    const deploy = workflow(async function* () {
      runs += 1;
      return "deployed";
    });
    const router = createWorkflowRouter({ deploy });
    const runtime = new NodeDurableRuntime({
      deploymentId: "completed-test",
      databasePath: path.join(directory, "workflows.db"),
    });
    try {
      const run = () =>
        runtime.run(router, {
          workflowId: "deploy",
          executionId: "completed-execution",
        });
      await expect(run()).resolves.toBe("deployed");
      await expect(run()).resolves.toBe("deployed");
      expect(runs).toBe(1);
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("canonicalises equivalent entry-point spellings", () => {
    const absolute = path.resolve("infra/api.ts");
    expect(resolveDeploymentId("infra/api.ts")).toBe("infra/api.ts");
    expect(resolveDeploymentId("./infra/api.ts")).toBe("infra/api.ts");
    expect(resolveDeploymentId(absolute)).toBe("infra/api.ts");
  });
});
