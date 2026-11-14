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
  PRODUCED_SOURCE: "produced",
  PROMPT_SOURCE: "prompt",
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

it("prints the order of each replace", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "role",
        type: "test/plan/role",
        decision: "replace",
        replaceFields: [{ name: "path", known: true }],
        replaceOrder: "create-first",
        params: {},
        dependsOn: [],
      },
      {
        id: "permission",
        type: "test/plan/permission",
        decision: "drift-replace",
        replaceFields: [{ name: "principal", known: true }],
        replaceOrder: "delete-first",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 5)).toEqual([
    "+/- replace test/plan/role role (create, then delete)",
    "    path forces replacement",
    "-/+ drift-replace test/plan/permission permission (delete, then create)",
    "    principal forces replacement",
  ]);
});

it("prints the delete of a retired instance, and counts it in the summary", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "role",
        type: "test/plan/role",
        decision: "noop",
        params: {},
        dependsOn: [],
      },
      {
        id: "role",
        type: "test/plan/role",
        decision: "delete-retired",
        retiredAt: "2026-11-13T00:00:00.000Z",
        params: {},
        dependsOn: [],
      },
      {
        id: "queue",
        type: "test/plan/queue",
        decision: "delete-orphan",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1)).toEqual([
    "- delete-retired test/plan/role role",
    "    the instance that a replace retired at 2026-11-13T00:00:00.000Z, deleted at the end of the deploy",
    "- delete-orphan test/plan/queue queue",
    "\nPlan: 0 to create, 0 to update, 0 to replace, 0 to recreate, 2 to delete, 1 unchanged.",
  ]);
});

it("prints the delete of a retired instance before a delete-first replace of its record", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "role",
        type: "test/plan/role",
        decision: "delete-retired",
        retiredAt: "2026-11-13T00:00:00.000Z",
        params: {},
        dependsOn: [],
      },
      {
        id: "role",
        type: "test/plan/role",
        decision: "replace",
        replaceFields: [{ name: "path", known: true }],
        replaceOrder: "delete-first",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 3)).toEqual([
    "- delete-retired test/plan/role role",
    "    the instance that a replace retired at 2026-11-13T00:00:00.000Z, deleted before the resource is replaced",
  ]);
});

it("reads the replace of a delete-first dependency, not its retired instance", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "rule",
        type: "test/plan/rule",
        decision: "delete-retired",
        retiredAt: "2026-11-13T00:00:00.000Z",
        params: {},
        dependsOn: ["bus"],
      },
      {
        id: "bus",
        type: "test/plan/bus",
        decision: "delete-retired",
        retiredAt: "2026-11-13T00:00:00.000Z",
        params: {},
        dependsOn: [],
      },
      {
        id: "rule",
        type: "test/plan/rule",
        decision: "replace",
        replaceOrder: "delete-first",
        replacedDependency: "bus",
        params: {},
        dependsOn: ["bus"],
      },
      {
        id: "bus",
        type: "test/plan/bus",
        decision: "replace",
        replaceFields: [{ name: "name", known: true }],
        replaceOrder: "delete-first",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 7)).toEqual([
    "- delete-retired test/plan/rule rule",
    "    the instance that a replace retired at 2026-11-13T00:00:00.000Z, deleted before the resource is replaced",
    "- delete-retired test/plan/bus bus",
    "    the instance that a replace retired at 2026-11-13T00:00:00.000Z, deleted before the resource is replaced",
    "-/+ replace test/plan/rule rule (delete, then create)",
    "    deleted before bus is replaced",
  ]);
});

it("writes the order of a replace in the JSON plan", async () => {
  const node = {
    id: "role",
    type: "test/plan/role",
    decision: "replace" as const,
    replaceOrder: "create-first" as const,
    params: {},
    dependsOn: [],
  };
  planApp.mockResolvedValueOnce({ createdAt: "", nodes: [node] });
  const chunks: string[] = [];
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => chunks.push(String(chunk)) > 0);

  try {
    await plan(deployment, { json: true, logger: { ...console } });
  } finally {
    write.mockRestore();
  }

  const output = chunks.join("");
  expect(JSON.parse(output).nodes).toEqual([node]);
});

it("prints that deploy asks for the value of a new secret without a source", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "secret:admin",
        type: "cloudflare/secrets-store/SecretsStoreSecret",
        decision: "create",
        params: { ValueFrom: { Secret: "admin", Source: "prompt" } },
        dependsOn: [],
      },
      {
        id: "secret:stripe-key",
        type: "cloudflare/secrets-store/SecretsStoreSecret",
        decision: "create",
        params: { ValueFrom: { Secret: "stripe-key", Source: "env" } },
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 4)).toEqual([
    "+ create cloudflare/secrets-store/SecretsStoreSecret secret:admin",
    "    value not set: deploy asks for it if the secret doesn't exist, and fails without a terminal",
    "+ create cloudflare/secrets-store/SecretsStoreSecret secret:stripe-key",
  ]);
});

it("labels the replacement of a resource that writes a produced secret as a rotation", async () => {
  const secretNode = (id: string, decision: "noop" | "create") => ({
    id: `secret:${id}`,
    type: "cloudflare/secrets-store/SecretsStoreSecret",
    decision,
    params: {
      ValueFrom: {
        Secret: id,
        Source: "produced",
        Producer: "token:deploy",
      },
    },
    dependsOn: ["secrets-store", "token:deploy"],
  });
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "token:deploy",
        type: "cloudflare/tokens/AccountToken",
        decision: "replace",
        replaceOrder: "delete-first",
        replaceFields: [{ name: "ValueTargets", known: true }],
        params: {},
        dependsOn: ["secrets-store"],
      },
      secretNode("deploy", "noop"),
      secretNode("copy", "create"),
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 4)).toEqual([
    "-/+ replace cloudflare/tokens/AccountToken token:deploy (delete, then create)",
    "    ValueTargets forces replacement",
    "    rotation: writes a new value to the secrets deploy, copy",
  ]);
});

it("lists only the secrets of the producer that aren't being deleted", async () => {
  const secretNode = (
    id: string,
    decision: "noop" | "replace" | "delete-orphan",
  ) => ({
    id: `secret:${id}`,
    type: "cloudflare/secrets-store/SecretsStoreSecret",
    decision,
    params: {
      ValueFrom: { Secret: id, Source: "produced", Producer: "token:deploy" },
    },
    dependsOn: ["secrets-store", "token:deploy"],
  });
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "secrets-store",
        type: "cloudflare/secrets-store/SecretsStore",
        decision: "replace",
        replaceOrder: "delete-first",
        replaceFields: [{ name: "Name", known: true }],
        params: {},
        dependsOn: [],
      },
      {
        id: "token:deploy",
        type: "cloudflare/tokens/AccountToken",
        decision: "replace",
        replaceOrder: "delete-first",
        replaceFields: [{ name: "ValueTargets", known: true }],
        params: {},
        dependsOn: ["secrets-store"],
      },
      secretNode("deploy", "replace"),
      secretNode("old", "delete-orphan"),
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.filter((line) => line.includes("rotation"))).toEqual([
    "    rotation: writes a new value to the secrets deploy",
  ]);
  const token = lines.findIndex((line) => line.includes("token:deploy"));
  expect(lines[token + 2]).toBe(
    "    rotation: writes a new value to the secrets deploy",
  );
});

it("doesn't label the first create of a resource that writes a produced secret", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "token:deploy",
        type: "cloudflare/tokens/AccountToken",
        decision: "create",
        params: {},
        dependsOn: [],
      },
      {
        id: "secret:deploy",
        type: "cloudflare/secrets-store/SecretsStoreSecret",
        decision: "create",
        params: { ValueFrom: { Secret: "deploy", Source: "produced" } },
        dependsOn: ["token:deploy"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.some((line) => line.includes("rotation"))).toBe(false);
});
