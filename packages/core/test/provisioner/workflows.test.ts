import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSameRequest,
  deployApp,
  destroyApp,
  formatRequest,
  planApp,
} from "src/provisioner";
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

it("deploys and plans in a secret context with the stage, the run ID and the prompt", async () => {
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
  ]);
  expect(secretContext()).toBeUndefined();
});

describe("assertSameRequest", () => {
  const saved = {
    replace: [
      { id: "role", instanceHash: "3c1f9a02" },
      { id: "bucket", instanceHash: "9e04b7d1" },
    ],
    overrideLossProtection: ["bucket"],
  };

  it("allows a resume that leaves out the flags, or passes the same ones in any order", () => {
    expect(() => assertSameRequest("e", saved, undefined)).not.toThrow();
    expect(() =>
      assertSameRequest("e", saved, {
        replace: [...saved.replace].reverse(),
        overrideLossProtection: ["bucket"],
      }),
    ).not.toThrow();
  });

  it("accepts a resume that repeats a flag", () => {
    expect(() =>
      assertSameRequest("e", saved, {
        replace: [...saved.replace, saved.replace[0]!],
        overrideLossProtection: ["bucket", "bucket"],
      }),
    ).not.toThrow();
  });

  it("refuses a resume with other flags", () => {
    expect(() =>
      assertSameRequest("e", saved, { replace: [saved.replace[0]!] }),
    ).toThrow(
      "Execution e was started with --replace bucket@9e04b7d1 --replace role@3c1f9a02 --override-loss-protection bucket. Leave out --replace and --credential, or pass the same flags.",
    );
    expect(() =>
      assertSameRequest("e", undefined, { replace: [saved.replace[0]!] }),
    ).toThrow(
      "Execution e was started without --replace or --credential. Leave out --replace, --override-loss-protection and --credential.",
    );
  });

  it("refuses a resume with another --credential", () => {
    const credential = { id: "app", name: "privateKey", variable: "KEY" };
    expect(() =>
      assertSameRequest(
        "e",
        { replace: [], credential: [{ ...credential, version: "7b1e52c0" }] },
        { replace: [], credential: [{ ...credential, version: "3c90a1f4" }] },
      ),
    ).toThrow(
      "Execution e was started with --credential app.privateKey@7b1e52c0=KEY.",
    );
  });

  it("formats no request as no flags", () => {
    expect(formatRequest(undefined)).toBe("");
  });
});
