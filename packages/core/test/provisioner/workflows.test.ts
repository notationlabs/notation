import { beforeEach, expect, it, vi } from "vitest";
import { deployApp, destroyApp, planApp } from "src/provisioner";

const { getResourceGraph } = vi.hoisted(() => ({
  getResourceGraph: vi.fn(async (..._args: unknown[]) => {
    throw new Error("stop after evaluation");
  }),
}));

vi.mock("src/orchestrator/graph", () => ({ getResourceGraph }));

const deployment = {
  app: "orders-app",
  stage: "prod",
  entry: "orders",
  entryPoint: "/project/infra/orders.ts",
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
  expect(getResourceGraph).toHaveBeenCalledWith(deployment.entryPoint, {
    app: "orders-app",
    stage: "prod",
  });
});
