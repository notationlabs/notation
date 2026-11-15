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
    await plan(deployment, { output: "json", logger: { ...console } });
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

it("prints that deploy asks for the value of a Worker's secret without a source when it creates the Worker or changes its secrets", async () => {
  const Secrets = {
    ADMIN: { Secret: "admin", Source: "prompt" },
    API_KEY: { Secret: "api-key", Source: "env", Key: "API_KEY" },
  };
  const type = "cloudflare/workers/WorkerScript";
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "worker:api",
        type,
        decision: "create",
        params: { Secrets },
        dependsOn: [],
      },
      {
        id: "worker:jobs",
        type,
        decision: "update",
        diff: { added: {}, deleted: {}, updated: { Secrets } },
        params: { Secrets },
        dependsOn: [],
      },
      {
        id: "worker:web",
        type,
        decision: "update",
        diff: { added: {}, deleted: {}, updated: { CodeSha256: "b" } },
        params: { Secrets },
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  const notSet =
    "    value not set: deploy asks for it if the secret doesn't exist, and fails without a terminal";
  const before = lines.flatMap((line, index) =>
    line === notSet ? [lines[index - 1]] : [],
  );
  expect(before).toEqual([
    `+ create ${type} worker:api`,
    `~ update ${type} worker:jobs`,
  ]);
});

it("prints a resource that only rotates a credential", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "token",
        type: "test/plan/token",
        decision: "noop",
        rotates: ["Value"],
        params: {},
        dependsOn: [],
      },
      {
        id: "secret",
        type: "test/plan/secret",
        decision: "create",
        params: {},
        dependsOn: ["token"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.slice(1, 4)).toEqual([
    "~ rotate test/plan/token token",
    "    Value gets a new value, as a resource that takes it needs one",
    "+ create test/plan/secret secret",
  ]);
});

it("prints why a resource is replaced to get a new credential", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "token",
        type: "test/plan/token",
        decision: "replace",
        replaceFields: [{ name: "Value", known: true, credential: true }],
        replaceOrder: "delete-first",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines).toContain(
    "    Value needs a new value, as a resource that takes it needs one, and it has no rotate operation",
  );
  expect(lines.join("\n")).not.toContain("forces replacement");
});

it("prints a resource at which deploy fails for want of a credential", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "secret",
        type: "test/plan/secret",
        decision: "replace",
        replaceFields: [{ name: "name", known: true }],
        replaceOrder: "delete-first",
        unheldCredentials: [{ resource: "token", name: "Value" }],
        params: {},
        dependsOn: ["token"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines).toContain(
    "    deploy fails here, as it holds no value for Value of token. The deploy after it replaces token",
  );
});
