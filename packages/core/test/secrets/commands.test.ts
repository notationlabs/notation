import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { scrubSecretValues } from "@notation/utils";
import {
  declareSecret,
  deleteSecret,
  setSecret,
  type DeclaredSecret,
} from "src/secrets";

const { getResourceGraph } = vi.hoisted(() => ({
  getResourceGraph: vi.fn(),
}));
vi.mock("src/orchestrator/graph", () => ({ getResourceGraph }));

const deployment = {
  app: "shop",
  stage: "dev",
  entryPoint: "/project/infra/main.ts",
  files: {},
};

// What the declarations' callbacks did, in order.
let calls: string[];

function declare(extra: Partial<DeclaredSecret> = {}) {
  getResourceGraph.mockImplementation(() =>
    collectResourceGraph(() => {
      for (const id of ["stripe-key", "admin"]) {
        declareSecret({
          id,
          set: async (value) => {
            calls.push(`set:${id}:${value}`);
          },
          delete: async () => {
            calls.push(`delete:${id}`);
          },
          ...extra,
        });
      }
    }),
  );
}

beforeEach(() => {
  calls = [];
  declare();
});

describe("setSecret", () => {
  it("calls the declaration's set with the value it read", async () => {
    await setSecret({
      deployment,
      id: "stripe-key",
      readValue: async () => "sk_live_123",
    });

    expect(calls).toEqual(["set:stripe-key:sk_live_123"]);
  });

  it("records the value, so the CLI removes it from what it prints", async () => {
    await setSecret({
      deployment,
      id: "stripe-key",
      readValue: async () => "sk_live_recorded",
    });

    expect(scrubSecretValues("got sk_live_recorded")).not.toContain(
      "sk_live_recorded",
    );
  });

  it("lists the declared ids for an unknown id", async () => {
    await expect(
      setSecret({ deployment, id: "missing", readValue: async () => "x" }),
    ).rejects.toThrow(
      'No secret has the id "missing". The declared secrets are: admin, stripe-key.',
    );
  });

  it("refuses a secret without set, before it reads the value", async () => {
    declare({
      set: undefined,
      refusal: "Only the token's create writes its value.",
    });
    const readValue = vi.fn(async () => "x");

    await expect(
      setSecret({ deployment, id: "stripe-key", readValue }),
    ).rejects.toThrow("Only the token's create writes its value.");
    expect(readValue).not.toHaveBeenCalled();
  });
});

describe("deleteSecret", () => {
  it("calls the declaration's delete once confirmed", async () => {
    await expect(
      deleteSecret({ deployment, id: "admin", confirm: async () => true }),
    ).resolves.toBe(true);

    expect(calls).toEqual(["delete:admin"]);
  });

  it("deletes nothing when not confirmed", async () => {
    await expect(
      deleteSecret({ deployment, id: "admin", confirm: async () => false }),
    ).resolves.toBe(false);

    expect(calls).toEqual([]);
  });

  it("refuses a secret without delete, with the declaration's refusal", async () => {
    declare({ delete: undefined, refusal: "Notation didn't create it." });

    await expect(
      deleteSecret({ deployment, id: "admin", confirm: async () => true }),
    ).rejects.toThrow("Notation didn't create it.");
  });

  it("refuses a secret without delete or a refusal", async () => {
    declare({ delete: undefined });

    await expect(
      deleteSecret({ deployment, id: "admin", confirm: async () => true }),
    ).rejects.toThrow("`notation secret delete` can't delete `admin`.");
  });
});

describe("declareSecret", () => {
  it("fails for two secrets with the same id", async () => {
    getResourceGraph.mockImplementation(() =>
      collectResourceGraph(() => {
        declareSecret({ id: "dup" });
        declareSecret({ id: "dup" });
      }),
    );

    await expect(
      setSecret({ deployment, id: "dup", readValue: async () => "x" }),
    ).rejects.toThrow('Two secrets have the id "dup".');
  });
});
