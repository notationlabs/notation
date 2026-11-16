import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSameOverrides,
  deployApp,
  destroyApp,
  formatOverrides,
  planApp,
} from "src/provisioner";

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

describe("assertSameOverrides", () => {
  const saved = {
    replace: [
      { id: "role", instanceHash: "3c1f9a02" },
      { id: "bucket", instanceHash: "9e04b7d1" },
    ],
    overrideLossProtection: ["bucket"],
  };

  it("allows a resume that leaves out the flags, or passes the same ones in any order", () => {
    expect(() => assertSameOverrides("e", saved, undefined)).not.toThrow();
    expect(() =>
      assertSameOverrides("e", saved, {
        replace: [...saved.replace].reverse(),
        overrideLossProtection: ["bucket"],
      }),
    ).not.toThrow();
  });

  it("accepts a resume that repeats a flag", () => {
    expect(() =>
      assertSameOverrides("e", saved, {
        replace: [...saved.replace, saved.replace[0]!],
        overrideLossProtection: ["bucket", "bucket"],
      }),
    ).not.toThrow();
  });

  it("refuses a resume with other flags", () => {
    expect(() =>
      assertSameOverrides("e", saved, { replace: [saved.replace[0]!] }),
    ).toThrow(
      "Execution e was started with --replace bucket@9e04b7d1 --replace role@3c1f9a02 --override-loss-protection bucket. Leave out --replace and --credential, or pass the same flags.",
    );
    expect(() =>
      assertSameOverrides("e", undefined, { replace: [saved.replace[0]!] }),
    ).toThrow(
      "Execution e was started without --replace or --credential. Leave out --replace, --override-loss-protection and --credential.",
    );
  });

  it("refuses a resume with another --credential", () => {
    const credential = { id: "app", name: "privateKey", variable: "KEY" };
    expect(() =>
      assertSameOverrides(
        "e",
        {
          replace: [],
          credential: [{ ...credential, instanceHash: "7b1e52c0" }],
        },
        {
          replace: [],
          credential: [{ ...credential, instanceHash: "3c90a1f4" }],
        },
      ),
    ).toThrow(
      "Execution e was started with --credential app.privateKey@7b1e52c0=KEY.",
    );
  });

  it("formats no request as no flags", () => {
    expect(formatOverrides(undefined)).toBe("");
  });
});
