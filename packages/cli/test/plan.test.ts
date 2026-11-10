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
        id: "bus",
        type: "test/plan/bus",
        decision: "replace",
        replaceFields: [{ name: "name", known: true }],
        params: {},
        dependsOn: [],
      },
      {
        id: "rule",
        type: "test/plan/rule",
        decision: "replace",
        replacedDependency: "bus",
        params: {},
        dependsOn: ["bus"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(3, 5)).toEqual([
    "-/+ replace test/plan/rule rule",
    "    deleted before bus is replaced",
  ]);
});

it("prints that a dependent is deleted only if an unknown field replaces its dependency", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "bus",
        type: "test/plan/bus",
        decision: "replace",
        replaceFields: [{ name: "name", known: false }],
        params: {},
        dependsOn: [],
      },
      {
        id: "rule",
        type: "test/plan/rule",
        decision: "replace",
        replacedDependency: "bus",
        params: {},
        dependsOn: ["bus"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(3, 5)).toEqual([
    "-/+ replace test/plan/rule rule",
    "    deleted if bus is replaced",
  ]);
});
