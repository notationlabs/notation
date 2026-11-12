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

it("prints the placeholder of a cycle", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "a",
        type: "test/plan/worker",
        decision: "create",
        cycle: ["b"],
        placeholder: true,
        params: {},
        dependsOn: ["b"],
      },
      {
        id: "b",
        type: "test/plan/worker",
        decision: "replace",
        replaceFields: [{ name: "name", known: true }],
        cycle: ["a"],
        params: {},
        dependsOn: ["a"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 5)).toEqual([
    "+ create test/plan/worker a",
    "    created first without the contributions that refer to b, the other members of its cycle",
    "-/+ replace test/plan/worker b",
    "    name forces replacement",
  ]);
});

it("prints the dependents whose references a replacement breaks", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "api",
        type: "test/plan/worker",
        decision: "replace",
        replaceFields: [{ name: "name", known: true }],
        brokenDependents: ["reports", "web"],
        params: {},
        dependsOn: [],
      },
      {
        id: "queue",
        type: "test/plan/worker",
        decision: "replace",
        replaceFields: [{ name: "name", known: false }],
        brokenDependents: ["web"],
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 7)).toEqual([
    "-/+ replace test/plan/worker api",
    "    name forces replacement",
    "    the references from reports, web are broken until deploy updates them",
    "-/+ replace test/plan/worker queue",
    "    name unknown, may force replacement",
    "    the references from web are broken until deploy updates them, if it is replaced",
  ]);
});
