import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as reconciler from "@notation/reconciler";
import { resource } from "@notation/resource";
import { createWorkflowRouter, workflow } from "yieldstar";
import { describe, expect, it } from "vitest";
import { NodeDurableRuntime } from "src/provisioner/durable-runtime";

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
});
