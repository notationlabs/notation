import type { Deployment, Plan } from "@notation/core";
import { expect, it, vi } from "vitest";

const deployment: Deployment = {
  app: "orders-app",
  stage: "prod",
  entryPoint: "/project/infra/app.ts",
  files: {},
};

const { planApp } = vi.hoisted(() => ({
  planApp: vi.fn(async (): Promise<Plan> => ({ createdAt: "", nodes: [] })),
}));

vi.mock("@notation/core", () => ({
  createLoggerReconcilerSubscriber: () => () => undefined,
  planApp,
  resolveDeploymentId: (d: Deployment) => `${d.app}:${d.stage}`,
}));
vi.mock("../src/compile", () => ({ compile: vi.fn(async () => undefined) }));

const { plan } = await import("../src/plan");

it("prints why a dependent of a replaced resource is replaced", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "rule",
        type: "test/plan/rule",
        decision: "replace",
        replacedDependencies: [
          { id: "bus", known: true },
          { id: "other-bus", known: false },
        ],
        deletedDependencies: [{ id: "old-bus", known: true }],
        params: {},
        dependsOn: ["bus", "other-bus"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 5)).toEqual([
    "-/+ replace test/plan/rule rule",
    "    depends on bus, which is replaced",
    "    depends on other-bus, which may be replaced",
    "    depends on old-bus, which is deleted",
  ]);
});
