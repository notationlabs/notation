import { beforeEach, expect, it, vi } from "vitest";
import { deployApp, destroyApp, planApp } from "src/provisioner";
import { getExecutionContext } from "src/secrets";

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
  getResourceGraph.mockClear();
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

it("sets execution context with stage and executionId for planApp, deployApp, and destroyApp", async () => {
  const seen: Array<{ stage: string; executionId: string } | undefined> = [];
  getResourceGraph.mockImplementation(async () => {
    seen.push(getExecutionContext());
    throw new Error("stop after evaluation");
  });

  await expect(planApp({ deployment })).rejects.toThrow(
    "stop after evaluation",
  );
  await expect(planApp({ deployment })).rejects.toThrow(
    "stop after evaluation",
  );
  await expect(
    deployApp({ deployment, executionId: "deploy-exec-1" }),
  ).rejects.toThrow("stop after evaluation");
  await expect(
    destroyApp({ deployment, executionId: "destroy-exec-1" }),
  ).rejects.toThrow("stop after evaluation");

  expect(seen).toHaveLength(4);
  expect(seen[0]?.stage).toBe("prod");
  expect(seen[1]?.stage).toBe("prod");
  expect(seen[0]?.executionId).toBeTruthy();
  expect(seen[1]?.executionId).toBeTruthy();
  expect(seen[0]?.executionId).not.toBe(seen[1]?.executionId);
  expect(seen[2]).toEqual({ stage: "prod", executionId: "deploy-exec-1" });
  expect(seen[3]).toEqual({ stage: "prod", executionId: "destroy-exec-1" });
});
