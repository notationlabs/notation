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

vi.mock("@notation/core", async (importOriginal) => ({
  formatOverrides: (await importOriginal<typeof import("@notation/core")>())
    .formatOverrides,
  shellQuote: (await importOriginal<typeof import("@notation/core")>())
    .shellQuote,
  findCredentialOverride: (
    await importOriginal<typeof import("@notation/core")>()
  ).findCredentialOverride,
  UnobtainableCredentialError: (
    await importOriginal<typeof import("@notation/core")>()
  ).UnobtainableCredentialError,
  unobtainableCredentialMessage: (
    await importOriginal<typeof import("@notation/core")>()
  ).unobtainableCredentialMessage,
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

it("prints a credential that --credential passes apart from one that rotates", async () => {
  const nodes = (rotates: string[]) => ({
    createdAt: "",
    nodes: [
      {
        id: "app",
        type: "test/plan/app",
        decision: "noop" as const,
        rotates,
        params: {},
        dependsOn: [],
      },
    ],
  });
  const overrides = {
    replace: [],
    credential: [{ id: "app", name: "privateKey", variable: "APP_KEY" }],
  };
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  planApp.mockResolvedValueOnce(nodes(["privateKey"]));
  await plan(deployment, { logger, overrides });
  planApp.mockResolvedValueOnce(nodes(["privateKey", "secret"]));
  await plan(deployment, { logger, overrides });

  expect(lines).toContain("~ pass test/plan/app app");
  expect(lines).toContain(
    "    privateKey gets the value that --credential passes",
  );
  expect(lines).toContain("~ rotate test/plan/app app");
  expect(lines).toContain(
    "    secret gets a new value, as a resource that takes it needs one",
  );
});

it("fails for a credential that deploy cannot get, with deploy commands for the same config, stage and request", async () => {
  const core =
    await vi.importActual<typeof import("@notation/core")>("@notation/core");
  planApp.mockRejectedValueOnce(
    new core.UnobtainableCredentialError(
      [
        {
          consumer: "app-key-secret",
          producer: "app",
          producerType: "github/App",
          name: "privateKey",
          instanceHash: "5d2e8b17",
          version: "7b1e52c0",
        },
      ],
      { replace: [{ id: "queue", instanceHash: "0c4d9e21" }] },
    ),
  );
  const logger = { ...console, info: () => undefined };

  const error = await plan(deployment, {
    logger,
    config: "jobs.config.ts",
    overrides: { replace: [{ id: "queue" }] },
  }).catch((e: Error) => e);

  expect((error as Error).message).toBe(
    [
      "app-key-secret needs app.privateKey, and deploy cannot get it. github/App issues privateKey once, at create.",
      "Either replace the resource `app`, or provide the credential `app.privateKey`.",
      "",
      "  Replace app, to issue a new value:",
      "    notation deploy --config jobs.config.ts --stage prod --replace queue@0c4d9e21 --replace app@5d2e8b17",
      "",
      "  Or pass a value that you hold:",
      "    notation deploy --config jobs.config.ts --stage prod --replace queue@0c4d9e21 --credential app.privateKey@7b1e52c0=APP_PRIVATE_KEY",
    ].join("\n"),
  );
});

it("prints the deploy command of a --credential with the version in state", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "app",
        type: "github/App",
        decision: "noop",
        rotates: ["privateKey"],
        credentialVersions: { privateKey: "7b1e52c0" },
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, {
    logger,
    overrides: {
      replace: [],
      credential: [{ id: "app", name: "privateKey", variable: "APP_KEY" }],
    },
  });

  expect(lines.at(-1)).toBe(
    "\nTo deploy this plan:\n  notation deploy --stage prod --credential app.privateKey@7b1e52c0=APP_KEY",
  );
});

it("prints a requested replace, and the deploy command with the instance hash", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "lambda:orders:role",
        type: "aws/lambda/LambdaIamRole",
        decision: "replace",
        replaceFields: [{ requested: true, known: true }],
        replaceOrder: "create-first",
        instanceHash: "3c1f9a02",
        params: {},
        dependsOn: [],
      },
      {
        id: "lambda:orders",
        type: "aws/lambda/LambdaFunction",
        decision: "update",
        instanceHash: "9e04b7d1",
        params: {},
        dependsOn: ["lambda:orders:role"],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };
  const overrides = {
    replace: [{ id: "lambda:orders:role" }],
    overrideLossProtection: ["lambda:orders:role"],
  };

  await plan(deployment, {
    logger,
    overrides,
    config: "jobs.config.ts",
  });

  expect(planApp).toHaveBeenLastCalledWith(
    expect.objectContaining({ overrides }),
  );
  expect(lines.slice(1, 3)).toEqual([
    "+/- replace aws/lambda/LambdaIamRole lambda:orders:role (create, then delete)",
    "    replaced by --replace",
  ]);
  expect(lines.at(-1)).toBe(
    "\nTo deploy this plan:\n  notation deploy --config jobs.config.ts --stage prod --replace lambda:orders:role@3c1f9a02 --override-loss-protection lambda:orders:role",
  );
});

it("quotes a value in the deploy command that the shell would split or expand", async () => {
  planApp.mockResolvedValueOnce({
    createdAt: "",
    nodes: [
      {
        id: "queue:it's",
        type: "test/plan/queue",
        decision: "replace",
        replaceFields: [{ requested: true, known: true }],
        instanceHash: "3c1f9a02",
        params: {},
        dependsOn: [],
      },
    ],
  });
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(
    { ...deployment, stage: "pr 12" },
    {
      logger,
      overrides: { replace: [{ id: "queue:it's" }] },
      config: "my app/notation.config.ts",
    },
  );

  expect(lines.at(-1)).toBe(
    "\nTo deploy this plan:\n  notation deploy --config 'my app/notation.config.ts' --stage 'pr 12' --replace 'queue:it'\\''s@3c1f9a02'",
  );
});

it("prints no deploy command without a request", async () => {
  const lines: string[] = [];
  const logger = { ...console, info: (line: string) => lines.push(line) };

  await plan(deployment, { logger });

  expect(lines.join("\n")).not.toContain("To deploy this plan");
});
