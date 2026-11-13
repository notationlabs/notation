import { beforeEach, expect, it, vi } from "vitest";
import { deployApp, destroyApp, planApp } from "src/provisioner";
import { secretContext } from "src/secrets";

const { getResourceGraph } = vi.hoisted(() => ({
  getResourceGraph: vi.fn(async (..._args: unknown[]) => {
    throw new Error("stop after evaluation");
  }),
}));

vi.mock("src/orchestrator/graph", () => ({ getResourceGraph }));

const deployment = {
  app: "orders-app",
  stage: "prod",
  entryPoint: "/project/infra/orders.ts",
  files: {},
};

beforeEach(() => {
  getResourceGraph.mockReset();
});

it.each([
  ["deployApp", () => deployApp({ deployment, executionId: "e" })],
  ["planApp", () => planApp({ deployment })],
  ["destroyApp", () => destroyApp({ deployment, executionId: "e" })],
])("%s evaluates infra with the deployment's app and stage", async (_, run) => {
  await expect(run()).rejects.toThrow("stop after evaluation");
  expect(getResourceGraph.mock.calls[0]?.slice(0, 2)).toEqual([
    deployment.entryPoint,
    { app: "orders-app", stage: "prod" },
  ]);
});

it("destroyApp evaluates infra without declaration checks", async () => {
  await expect(destroyApp({ deployment, executionId: "e" })).rejects.toThrow(
    "stop after evaluation",
  );
  expect(getResourceGraph.mock.calls[0]?.[2]).toEqual({
    declarationChecks: false,
  });
});

it("evaluates infra in a secret context with the stage, the run ID and the prompt", async () => {
  const contexts: unknown[] = [];
  getResourceGraph.mockImplementation(async () => {
    const { stage, runId, prompt } = secretContext()!;
    contexts.push({ stage, runId, prompt });
    throw new Error("stop after evaluation");
  });
  const promptSecret = async () => "value";

  await expect(
    deployApp({ deployment, executionId: "e1", promptSecret }),
  ).rejects.toThrow();
  await expect(planApp({ deployment })).rejects.toThrow();
  await expect(destroyApp({ deployment, executionId: "e2" })).rejects.toThrow();

  expect(contexts).toEqual([
    {
      stage: "prod",
      runId: "e1",
      prompt: promptSecret,
    },
    {
      stage: "prod",
      runId: expect.any(String),
      prompt: undefined,
    },
    { stage: "prod", runId: "e2", prompt: undefined },
  ]);
  expect(secretContext()).toBeUndefined();
});
