import * as v from "valibot";
import {
  UNKNOWN_AFTER_APPLY,
  resource,
  type DurableObject,
} from "@notation/resource";
import { MemoryStateBackend, type StateNode } from "@notation/state";
import { describe, expect, it } from "vitest";
import { createPlan } from "../src/planner";
import {
  formatRequest,
  instanceHash,
  parseCredentialTarget,
  parseReplaceTarget,
  type ReplaceRequest,
} from "../src/replace-request";

const deploymentId = "shop:prod";

// Casts: a resource declared without API types constrains every schema key
// to be a key of an `any` API schema, which no named key satisfies.
const Queue = resource({ type: "test/replace/queue", provider: "test" })
  .defineSchema({
    name: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      value: v.string(),
      physicalName: { maxLength: 64 },
    },
    path: {
      propertyType: "param",
      presence: "required",
      immutable: true,
      value: v.string(),
    },
    target: {
      propertyType: "param",
      presence: "optional",
      value: v.string(),
    },
  } as any)
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    read: async () => {
      throw new Error("a requested replace reads nothing");
    },
    delete: async () => undefined,
  });

const Bucket = resource({ type: "test/replace/bucket", provider: "test" })
  .defineSchema({
    name: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      immutable: true,
      rejectReplace: (previous: string, desired: string) =>
        `the bucket name is ${desired}, but the bucket was created as ${previous}`,
      value: v.string(),
    },
  } as any)
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
    rejectChange: (_previous, _desired, context) =>
      context.replace
        ? `Replacing this bucket would delete its objects${context.requested ? " (requested)" : ""}.`
        : undefined,
  });

// A delete-first class whose records block the delete of a bucket.
const Binding = resource({
  type: "test/replace/binding",
  provider: "test",
  blocksDeleteOf: [Bucket.type],
})
  .defineSchema({
    bucket: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
  } as any)
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });

const record = (
  id: string,
  type: string,
  params: DurableObject,
  lastOperation: StateNode["lastOperation"] = "create",
  dependsOn: string[] = [],
): StateNode => ({
  version: 1,
  id,
  type,
  provider: "test",
  config: {},
  params,
  output: params,
  dependsOn,
  lastOperation,
  lastOperationAt: "2026-07-22T00:00:00.000Z",
});

const ordersName = "shop--prod--orders-1a2b3c4d";
const mirrorName = "shop--prod--mirror-5e6f7a8b";

function queues() {
  const orders = new Queue("orders", { config: { path: "/" } as any });
  const mirror = new Queue("mirror", { config: { path: "/" } as any });
  mirror.config.target = orders.outputRef("name");
  const state = new MemoryStateBackend({
    orders: record("orders", Queue.type, { name: ordersName, path: "/" }),
    mirror: record(
      "mirror",
      Queue.type,
      { name: mirrorName, path: "/", target: ordersName },
      "create",
      ["orders"],
    ),
  });
  return { resources: [orders, mirror], state };
}

const queue = new Queue("orders", { config: { path: "/" } as any });
const hashOf = (node: StateNode) => instanceHash(deploymentId, queue, node);

describe("instanceHash", () => {
  it("is 8 hex characters that differ by deployment and by primary key", () => {
    const node = record("orders", Queue.type, { name: ordersName, path: "/" });
    const hash = instanceHash(deploymentId, queue, node);

    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(instanceHash(deploymentId, queue, node)).toBe(hash);
    expect(instanceHash("shop:dev", queue, node)).not.toBe(hash);
    expect(
      instanceHash(
        deploymentId,
        queue,
        record("orders", Queue.type, { name: "other", path: "/" }),
      ),
    ).not.toBe(hash);
    // A param that is not the primary key does not change the hash.
    expect(
      instanceHash(
        deploymentId,
        queue,
        record("orders", Queue.type, { name: ordersName, path: "/new/" }),
      ),
    ).toBe(hash);
  });
});

describe("parseReplaceTarget", () => {
  it("reads the ID before the last @ and the hash after it", () => {
    expect(parseReplaceTarget("lambda:orders:role@3c1f9a02")).toEqual({
      id: "lambda:orders:role",
      instanceHash: "3c1f9a02",
    });
    expect(parseReplaceTarget("a@b@3c1f9a02")).toEqual({
      id: "a@b",
      instanceHash: "3c1f9a02",
    });
    expect(parseReplaceTarget("lambda:orders:role")).toEqual({
      id: "lambda:orders:role",
    });
  });

  it("reads a value whose part after the last @ is not 8 hex characters as an ID", () => {
    expect(parseReplaceTarget("orders@xyz")).toEqual({ id: "orders@xyz" });
    expect(parseReplaceTarget("orders@")).toEqual({ id: "orders@" });
    expect(parseReplaceTarget("@3c1f9a02")).toEqual({ id: "@3c1f9a02" });
  });

  it("reads an uppercase hash as lowercase", () => {
    expect(parseReplaceTarget("orders@3C1F9A02")).toEqual({
      id: "orders",
      instanceHash: "3c1f9a02",
    });
  });
});

describe("parseCredentialTarget", () => {
  it("splits at the last dot before the version, and at the last = ", () => {
    expect(parseCredentialTarget("worker:a.b.privateKey@7B1E52C0=KEY")).toEqual(
      {
        id: "worker:a.b",
        name: "privateKey",
        version: "7b1e52c0",
        variable: "KEY",
      },
    );
  });

  it("reads a value with no version", () => {
    expect(parseCredentialTarget("app.privateKey=KEY")).toEqual({
      id: "app",
      name: "privateKey",
      variable: "KEY",
    });
  });

  it("throws for a value with no variable or no credential", () => {
    expect(() => parseCredentialTarget("app.privateKey@7b1e52c0")).toThrow(
      "is malformed",
    );
    expect(() => parseCredentialTarget("app@7b1e52c0=KEY")).toThrow(
      "is malformed",
    );
  });

  it("is formatted back as a flag", () => {
    expect(
      formatRequest({
        replace: [],
        credential: [parseCredentialTarget("app.privateKey@7b1e52c0=KEY")],
      }),
    ).toBe("--credential app.privateKey@7b1e52c0=KEY");
  });
});

describe("createPlan with a requested replace", () => {
  it("replaces an unchanged resource create-first, and updates the dependent that takes its name", async () => {
    const { resources, state } = queues();

    const plan = await createPlan({
      resources,
      state,
      driftDetection: true,
      deploymentId,
      requested: { replace: [{ id: "orders" }] },
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "replace",
        replaceFields: [{ requested: true, known: true }],
        replaceOrder: "create-first",
        params: { name: UNKNOWN_AFTER_APPLY, path: "/" },
      }),
      expect.objectContaining({
        id: "mirror",
        decision: "update",
        params: { name: mirrorName, path: "/", target: UNKNOWN_AFTER_APPLY },
      }),
    ]);
  });

  it("shows one replace with both reasons when a param also forces it", async () => {
    const { resources, state } = queues();
    resources[0]!.config.path = "/new/";

    const plan = await createPlan({
      resources,
      state,
      driftDetection: false,
      deploymentId,
      requested: { replace: [{ id: "orders" }] },
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "orders",
      decision: "replace",
      replaceFields: [
        { name: "path", known: true },
        { requested: true, known: true },
      ],
    });
  });

  it("adds the instance hash to each node of a resource with a record", async () => {
    const { resources, state } = queues();
    const added = new Queue("added", { config: { path: "/" } as any });

    const plan = await createPlan({
      resources: [...resources, added],
      state,
      driftDetection: false,
      deploymentId,
    });

    expect(plan.nodes.map((node) => [node.id, node.instanceHash])).toEqual([
      ["orders", hashOf((await state.get("orders"))!)],
      ["added", undefined],
      ["mirror", hashOf((await state.get("mirror"))!)],
    ]);
  });

  it("checks the hash when it is given", async () => {
    const { resources, state } = queues();
    const hash = hashOf((await state.get("orders"))!);
    const plan = (instanceHash: string) =>
      createPlan({
        resources,
        state,
        driftDetection: false,
        deploymentId,
        requested: { replace: [{ id: "orders", instanceHash }] },
      });

    await expect(plan(hash)).resolves.toBeDefined();
    await expect(plan("00000000")).rejects.toThrow(
      `orders has the instance hash ${hash} in this stage, not 00000000.`,
    );
  });

  describe("fails before it plans anything", () => {
    const plan = (
      requested: ReplaceRequest,
      records: StateNode[] = [
        record("orders", Queue.type, { name: ordersName, path: "/" }),
      ],
    ) =>
      createPlan({
        resources: [new Queue("orders", { config: { path: "/" } as any })],
        state: new MemoryStateBackend(
          Object.fromEntries(records.map((node) => [node.id, node])),
        ),
        driftDetection: false,
        deploymentId,
        requested,
      });

    it("when the ID is not in state", async () => {
      await expect(plan({ replace: [{ id: "orders" }] }, [])).rejects.toThrow(
        "orders is not in state, so there is nothing to replace. Deploy will create it.",
      );
      await expect(plan({ replace: [{ id: "missing" }] })).rejects.toThrow(
        "missing is not in state or in code, so there is nothing to replace.",
      );
    });

    it("when the ID is in state but not in code", async () => {
      await expect(
        plan({ replace: [{ id: "old" }] }, [
          record("orders", Queue.type, { name: ordersName, path: "/" }),
          record("old", Queue.type, { name: "old", path: "/" }),
        ]),
      ).rejects.toThrow("old is no longer in code. Deploy will delete it.");
    });

    it("when the record is creating", async () => {
      await expect(
        plan({ replace: [{ id: "orders" }] }, [
          record(
            "orders",
            Queue.type,
            { name: ordersName, path: "/" },
            "creating",
          ),
        ]),
      ).rejects.toThrow(
        "orders has a create that an earlier deploy did not finish. Run deploy without --replace to recover it first.",
      );
    });

    it("when the hash after a known ID is hex of the wrong length", async () => {
      await expect(
        plan({ replace: [parseReplaceTarget("orders@3c1f9a0")] }),
      ).rejects.toThrow(
        "The instance hash 3c1f9a0 of orders is malformed. An instance hash is 8 hex characters.",
      );
    });

    it("when the resource is a source", async () => {
      const Source = resource({ type: "test/replace/source", provider: "test" })
        .defineSchema({
          key: {
            propertyType: "param",
            presence: "required",
            value: v.string(),
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        });

      await expect(
        createPlan({
          resources: [
            new Source("env:stripe-key", { config: { key: "k" } as any }),
          ],
          state: new MemoryStateBackend({
            "env:stripe-key": record("env:stripe-key", Source.type, {
              key: "k",
            }),
          }),
          driftDetection: false,
          deploymentId,
          requested: { replace: [{ id: "env:stripe-key" }] },
        }),
      ).rejects.toThrow(
        "env:stripe-key is a source, and a source is never replaced. Nothing exists at a provider to replace.",
      );
    });

    it("when --override-loss-protection names a resource that --replace does not", async () => {
      await expect(
        plan({ replace: [], overrideLossProtection: ["orders"] }),
      ).rejects.toThrow(
        "--override-loss-protection orders needs --replace orders.",
      );
    });
  });

  describe("of a class whose rejectChange refuses a replace", () => {
    const bucketState = () =>
      new MemoryStateBackend({
        uploads: record("uploads", Bucket.type, { name: "uploads" }),
      });
    const bucket = (name = "uploads") =>
      new Bucket("uploads", { config: { name } as any });

    it("fails with the class's message and the flag that overrides it", async () => {
      await expect(
        createPlan({
          resources: [bucket()],
          state: bucketState(),
          driftDetection: false,
          deploymentId,
          requested: { replace: [{ id: "uploads" }] },
        }),
      ).rejects.toThrow(
        "uploads: Replacing this bucket would delete its objects (requested). To replace it, pass --override-loss-protection uploads with --replace.",
      );
    });

    it("replaces it with --override-loss-protection", async () => {
      const plan = await createPlan({
        resources: [bucket()],
        state: bucketState(),
        driftDetection: false,
        deploymentId,
        requested: {
          replace: [{ id: "uploads" }],
          overrideLossProtection: ["uploads"],
        },
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          id: "uploads",
          decision: "replace",
          replaceOrder: "delete-first",
        }),
      ]);
    });

    it("still fails a changed param with the param's rejectReplace", async () => {
      await expect(
        createPlan({
          resources: [bucket("renamed")],
          state: bucketState(),
          driftDetection: false,
        }),
      ).rejects.toThrow(
        "uploads: the bucket name is renamed, but the bucket was created as uploads",
      );
    });

    it("deletes and creates again a dependent that blocks the delete", async () => {
      const uploads = bucket();
      const binding = new Binding("binding", {
        config: { bucket: uploads.outputRef("name") } as any,
      });

      const plan = await createPlan({
        resources: [uploads, binding],
        state: new MemoryStateBackend({
          uploads: record("uploads", Bucket.type, { name: "uploads" }),
          binding: record(
            "binding",
            Binding.type,
            { bucket: "uploads" },
            "create",
            ["uploads"],
          ),
        }),
        driftDetection: false,
        deploymentId,
        requested: {
          replace: [{ id: "uploads" }],
          overrideLossProtection: ["uploads"],
        },
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({ id: "uploads", decision: "replace" }),
        expect.objectContaining({
          id: "binding",
          decision: "replace",
          replaceOrder: "delete-first",
          replacedDependency: "uploads",
        }),
      ]);
    });
  });
});
