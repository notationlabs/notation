import * as v from "valibot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import type { NodeDurableRuntime } from "src/provisioner/durable-runtime";
import { resource } from "src";
import {
  declareSecret,
  deleteSecret,
  secretContext,
  setSecret,
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

const store = resource<{
  Key: {};
  CreateParams: {};
  UpdateParams: {};
  ReadResult: { StoreId: string };
}>({ type: "test/secrets/Store", provider: "test" })
  .defineSchema({
    StoreId: {
      propertyType: "computed",
      presence: "required",
      value: v.string(),
    },
  } as const)
  .defineOperations({ create: async () => {}, delete: async () => {} });

// What the test resource wrote, by name.
let written: Map<string, string>;

const secretResource = resource<{
  Key: { StoreId: string; Name: string };
  CreateParams: { StoreId: string; Name: string };
  UpdateParams: {};
  ReadResult: {};
}>({ type: "test/secrets/Secret", provider: "test" })
  .defineSchema({
    StoreId: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      secondaryKey: true,
      value: v.string(),
    },
    Name: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      primaryKey: true,
      value: v.string(),
    },
  } as const)
  .defineOperations({
    create: async (params) => {
      written.set(
        `create:${params.Name}`,
        secretContext()!.supplied!.value.unwrap(),
      );
    },
    update: async (key) => {
      written.set(
        `update:${key.Name}`,
        secretContext()!.supplied!.value.unwrap(),
      );
    },
    delete: async (key) => {
      written.set(`delete:${key.Name}`, "");
    },
  })
  .requireDependencies<{ store: InstanceType<typeof store> }>()
  .deriveParams(async ({ deps }) => ({ StoreId: deps.store.output.StoreId }));

function declare(extra: { refuseSet?: string; refuseDelete?: string } = {}) {
  getResourceGraph.mockImplementation(() =>
    collectResourceGraph(() => {
      const s = new store("store");
      for (const id of ["stripe-key", "admin"]) {
        declareSecret({
          id,
          resource: new secretResource(`secret:${id}`, {
            config: { Name: `shop--dev--${id}` },
            dependencies: { store: s },
          }),
          ...extra,
        });
      }
    }),
  );
}

function runtimeWith(records: Record<string, Record<string, unknown>>) {
  return {
    deploymentId: "shop:dev",
    state: {
      get: async (id: string) =>
        records[id] ? { id, output: records[id] } : undefined,
    },
  } as unknown as NodeDurableRuntime;
}

const deployedStore = { store: { StoreId: "s1" } };

beforeEach(() => {
  written = new Map();
  declare();
});

describe("setSecret", () => {
  it("creates a secret with no record, with the value it read", async () => {
    await setSecret({
      deployment,
      id: "stripe-key",
      runtime: runtimeWith(deployedStore),
      readValue: async () => "sk_live_123",
    });

    expect(written).toEqual(
      new Map([["create:shop--dev--stripe-key", "sk_live_123"]]),
    );
  });

  it("updates a secret that has a record", async () => {
    await setSecret({
      deployment,
      id: "stripe-key",
      runtime: runtimeWith({
        ...deployedStore,
        "secret:stripe-key": { StoreId: "s1", Name: "shop--dev--stripe-key" },
      }),
      readValue: async () => "sk_live_123",
    });

    expect(written).toEqual(
      new Map([["update:shop--dev--stripe-key", "sk_live_123"]]),
    );
  });

  it("fails before it reads the value when the location depends on a resource that hasn't been deployed", async () => {
    const readValue = vi.fn(async () => "x");

    await expect(
      setSecret({
        deployment,
        id: "stripe-key",
        runtime: runtimeWith({}),
        readValue,
      }),
    ).rejects.toThrow(
      "`stripe-key`'s location depends on `store`, which hasn't been deployed. Run `notation deploy`.",
    );
    expect(readValue).not.toHaveBeenCalled();
  });

  it("lists the declared ids for an unknown id", async () => {
    await expect(
      setSecret({
        deployment,
        id: "missing",
        runtime: runtimeWith(deployedStore),
        readValue: async () => "x",
      }),
    ).rejects.toThrow(
      'No secret has the id "missing". The declared secrets are: admin, stripe-key.',
    );
  });

  it("refuses a secret whose declaration refuses it", async () => {
    declare({ refuseSet: "Only the token's create writes its value." });

    await expect(
      setSecret({
        deployment,
        id: "stripe-key",
        runtime: runtimeWith(deployedStore),
        readValue: async () => "x",
      }),
    ).rejects.toThrow("Only the token's create writes its value.");
  });
});

describe("deleteSecret", () => {
  it("deletes the secret once confirmed", async () => {
    await expect(
      deleteSecret({
        deployment,
        id: "admin",
        runtime: runtimeWith(deployedStore),
        confirm: async () => true,
      }),
    ).resolves.toBe(true);

    expect([...written.keys()]).toEqual(["delete:shop--dev--admin"]);
  });

  it("deletes nothing when not confirmed", async () => {
    await expect(
      deleteSecret({
        deployment,
        id: "admin",
        runtime: runtimeWith(deployedStore),
        confirm: async () => false,
      }),
    ).resolves.toBe(false);

    expect(written.size).toBe(0);
  });

  it("refuses a secret whose declaration refuses its delete", async () => {
    declare({ refuseDelete: "Notation didn't create it." });

    await expect(
      deleteSecret({
        deployment,
        id: "admin",
        runtime: runtimeWith(deployedStore),
        confirm: async () => true,
      }),
    ).rejects.toThrow("Notation didn't create it.");
  });
});

describe("declareSecret", () => {
  it("fails for two secrets with the same id", async () => {
    getResourceGraph.mockImplementation(() =>
      collectResourceGraph(() => {
        const s = new store("store");
        for (const n of [1, 2]) {
          declareSecret({
            id: "dup",
            resource: new secretResource(`secret:${n}`, {
              config: { Name: `n${n}` },
              dependencies: { store: s },
            }),
          });
        }
      }),
    );

    await expect(
      setSecret({
        deployment,
        id: "dup",
        runtime: runtimeWith(deployedStore),
        readValue: async () => "x",
      }),
    ).rejects.toThrow('Two secrets have the id "dup".');
  });
});
