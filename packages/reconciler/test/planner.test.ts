import * as v from "valibot";
import {
  UNKNOWN_AFTER_APPLY,
  mergeContributions,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  resource,
  type BaseResource,
  type DurableObject,
} from "@notation/resource";
import { MemoryStateBackend } from "@notation/state";
import { describe, expect, it } from "vitest";
import { createPlan } from "../src/planner";
import { ResourceTypeChangedError } from "../src/resource-type";

describe("createPlan", () => {
  it("plans desired creates and persisted orphans without mutation execution", async () => {
    const TestResource = resource({
      type: "test/planner/resource",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      orphan: {
        version: 1,
        id: "orphan",
        type: TestResource.type,
        provider: "test",
        config: {},
        params: {},
        output: {},
        dependsOn: ["orphan-role"],
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("desired")],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "desired", decision: "create" }),
      expect.objectContaining({
        id: "orphan",
        decision: "delete-orphan",
        dependsOn: ["orphan-role"],
      }),
    ]);
  });

  it("fails when a resource has the ID of a state record of another type", async () => {
    const NewResource = resource({ type: "test/planner/new", provider: "test" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      permission: {
        version: 1,
        id: "permission",
        type: "test/planner/old",
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = createPlan({
      resources: [new NewResource("permission")],
      state,
      driftDetection: false,
    });

    await expect(plan).rejects.toSatisfy(ResourceTypeChangedError.is);
    await expect(plan).rejects.toThrow(
      "Resource permission has type test/planner/new in the graph, but its " +
        "state record has type test/planner/old. A resource can't change " +
        "type under the same ID. The provider must give the " +
        "test/planner/new resource a new ID",
    );
  });

  it("plans the record of an old type under another ID as an orphan", async () => {
    const NewResource = resource({ type: "test/planner/new", provider: "test" })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      permission: {
        version: 1,
        id: "permission",
        type: "test/planner/old",
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new NewResource("invoke-permission")],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toMatchObject([
      { id: "invoke-permission", decision: "create" },
      { id: "permission", type: "test/planner/old", decision: "delete-orphan" },
    ]);
  });

  it("propagates unexpected read failures", async () => {
    const TestResource = resource({
      type: "test/planner/read-failure",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new Error("access denied");
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    await expect(
      createPlan({
        resources: [new TestResource("existing")],
        state,
      }),
    ).rejects.toThrow("access denied");
  });

  it("plans recreation when the resource reports absence", async () => {
    const TestResource = resource({
      type: "test/planner/absent",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new ResourceNotFoundError("resource is absent");
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("existing")],
      state,
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "existing",
      decision: "drift-recreate",
    });
  });

  it("waits for a pending read before planning", async () => {
    let attempts = 0;
    const TestResource = resource({
      type: "test/planner/pending",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new ResourceOperationPendingError(
              "Waiting for the provider",
              { retryAfterMs: 0 },
            );
          }
          return {};
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      existing: {
        version: 1,
        id: "existing",
        type: TestResource.type,
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("existing")],
      state,
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "existing",
      decision: "noop",
    });
    expect(attempts).toBe(2);
  });

  it("plans a replacement, and its cascade to dependents, from the schema", async () => {
    // Casts: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
    const Role = resource({ type: "test/planner/role", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        path: {
          presence: "required",
          propertyType: "param",
          immutable: true,
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    // No update: any change replaces it.
    const Attachment = resource({
      type: "test/planner/attachment",
      provider: "test",
    })
      .defineSchema({
        roleName: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
        policyArn: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ role: InstanceType<typeof Role> }>()
      .deriveParams(({ deps }) => ({
        roleName: (deps.role.output as any).name,
      }));
    const record = (id: string, type: string, params: DurableObject) => ({
      version: 1,
      id,
      type,
      provider: "test",
      config: {},
      params,
      output: params,
      lastOperation: "create" as const,
      lastOperationAt: "2026-07-22T00:00:00.000Z",
    });
    const state = new MemoryStateBackend({
      role: record("role", Role.type, { name: "app", path: "/" }),
      attachment: record("attachment", Attachment.type, {
        roleName: "app",
        policyArn: "arn:policy",
      }),
    });
    const role = new Role("role", {
      config: { name: "app", path: "/service/" } as any,
    });
    const attachment = new Attachment("attachment", {
      config: { policyArn: "arn:policy" } as any,
      dependencies: { role },
    });

    const plan = await createPlan({
      resources: [role, attachment],
      state,
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "role",
        decision: "replace",
        replaceFields: [{ name: "path", known: true }],
      }),
      // The replaced role's name is unknown until it exists again.
      expect.objectContaining({
        id: "attachment",
        decision: "replace",
        replaceFields: [{ name: "roleName", known: false }],
      }),
    ]);
  });

  it("fails when a changed param rejects replacement", async () => {
    const Store = resource({ type: "test/planner/store", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        account: {
          presence: "required",
          propertyType: "param",
          immutable: true,
          rejectReplace: (previous: string, desired: string) =>
            `the account changed from ${previous} to ${desired}`,
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const plan = (config: Record<string, unknown>) =>
      createPlan({
        resources: [new Store("store", { config: config as any })],
        state: new MemoryStateBackend({
          store: {
            version: 1,
            id: "store",
            type: Store.type,
            provider: "test",
            config: {},
            params: { name: "app", account: "one" },
            output: { name: "app", account: "one" },
            lastOperation: "create",
            lastOperationAt: "2026-07-22T00:00:00.000Z",
          },
        }),
        driftDetection: false,
      });

    await expect(plan({ name: "app", account: "two" })).rejects.toThrow(
      "store: the account changed from one to two",
    );
    // Another param still replaces the resource.
    expect(
      (await plan({ name: "other", account: "one" })).nodes[0],
    ).toMatchObject({ decision: "replace" });
  });

  describe("replaces the dependents that block the delete of a replaced resource", () => {
    // A bus whose name is its key, as AWS names an event bus.
    const name = {
      presence: "required",
      propertyType: "param",
      primaryKey: true,
      value: v.string(),
    };
    const operations = {
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    };
    const Bus = resource({ type: "test/planner/bus", provider: "test" })
      // Cast: see above.
      .defineSchema({ name } as any)
      .defineOperations(operations);
    // A bus whose name comes from a zone, so that it is unknown while the
    // zone is replaced.
    const Zone = resource({ type: "test/planner/zone", provider: "test" })
      .defineSchema({ name } as any)
      .defineOperations(operations);
    const ZoneBus = resource({
      type: "test/planner/zone-bus",
      provider: "test",
    })
      .defineSchema({ name } as any)
      .defineOperations(operations)
      .requireDependencies<{ zone: BaseResource }>()
      .deriveParams(({ deps }) => ({
        name: (deps.zone.output as any).name,
      }));
    // A resource that names its parent in a param that can be updated, so
    // that it is replaced only because deploy deletes it before its parent.
    const defineChild = (
      type: `${string}/${string}/${string}`,
      blocksDeleteOf?: `${string}/${string}/${string}`[],
    ) =>
      resource({ type, provider: "test", blocksDeleteOf })
        .defineSchema({
          name,
          parent: {
            presence: "required",
            propertyType: "param",
            value: v.string(),
          },
        } as any)
        .defineOperations(operations)
        .requireDependencies<{ parent: BaseResource }>()
        .deriveParams(({ deps }) => ({
          parent: (deps.parent.output as any).name,
        }));
    // A rule blocks the delete of its bus, as on AWS.
    const Rule = defineChild("test/planner/rule", [Bus.type, ZoneBus.type]);
    // A target blocks the delete of its rule.
    const Target = defineChild("test/planner/target", [Rule.type]);
    // A permission, or a function with the bus name in its env, does not
    // block the delete of what it depends on.
    const Permission = defineChild("test/planner/permission");
    // A rule of a type that no resource in code has, so that plan has no
    // class for it unless it is registered.
    const Stray = defineChild("test/planner/stray", [Bus.type, ZoneBus.type]);
    const record = (
      id: string,
      type: string,
      params: DurableObject,
      dependsOn: string[],
    ) => ({
      version: 1,
      id,
      type,
      provider: "test",
      config: {},
      params,
      output: params,
      dependsOn,
      lastOperation: "create" as const,
      lastOperationAt: "2026-07-22T00:00:00.000Z",
    });
    const child = (Type: typeof Rule, id: string, parent: BaseResource) =>
      new Type(id, {
        config: { name: id } as any,
        dependencies: { parent },
      });

    it("directly and transitively, naming the replaced resource", async () => {
      const state = new MemoryStateBackend({
        bus: record("bus", Bus.type, { name: "orders" }, []),
        rule: record("rule", Rule.type, { name: "rule", parent: "orders" }, [
          "bus",
        ]),
        target: record(
          "target",
          Target.type,
          { name: "target", parent: "rule" },
          ["rule"],
        ),
        permission: record(
          "permission",
          Permission.type,
          { name: "permission", parent: "rule" },
          ["rule"],
        ),
        fn: record("fn", Permission.type, { name: "fn", parent: "orders" }, [
          "bus",
        ]),
        other: record("other", Bus.type, { name: "other" }, []),
      });
      const bus = new Bus("bus", { config: { name: "shop" } as any });
      const rule = child(Rule, "rule", bus);
      const target = child(Target, "target", rule);
      const permission = child(Permission, "permission", rule);
      const fn = child(Permission, "fn", bus);
      const other = new Bus("other", { config: { name: "other" } as any });

      const plan = await createPlan({
        resources: [bus, rule, target, permission, fn, other],
        state,
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          id: "bus",
          decision: "replace",
          replaceFields: [{ name: "name", known: true }],
        }),
        expect.objectContaining({ id: "other", decision: "noop" }),
        expect.objectContaining({
          id: "rule",
          decision: "replace",
          replacedDependency: "bus",
        }),
        // The bus's name is unknown until it is created again.
        expect.objectContaining({ id: "fn", decision: "update" }),
        expect.objectContaining({
          id: "target",
          decision: "replace",
          replacedDependency: "bus",
        }),
        expect.objectContaining({ id: "permission", decision: "update" }),
      ]);
      for (const id of ["bus", "other", "fn", "permission"]) {
        const node = plan.nodes.find((node) => node.id === id);
        expect(node).not.toHaveProperty("replacedDependency");
      }
      // The rule is created again, so the diff of its parent does not apply.
      expect(plan.nodes[2]).not.toHaveProperty("diff");
    });

    it("by the edges in code, for a dependent whose record has no edges", async () => {
      const { dependsOn: _, ...ruleRecord } = record(
        "rule",
        Rule.type,
        { name: "rule", parent: "orders" },
        [],
      );
      const state = new MemoryStateBackend({
        bus: record("bus", Bus.type, { name: "orders" }, []),
        rule: ruleRecord,
      });
      const bus = new Bus("bus", { config: { name: "shop" } as any });
      const rule = child(Rule, "rule", bus);

      const plan = await createPlan({
        resources: [bus, rule],
        state,
        driftDetection: false,
      });

      expect(plan.nodes[1]).toMatchObject({
        id: "rule",
        decision: "replace",
        replacedDependency: "bus",
      });
    });

    it("by the edges in state, for a dependent that moves to another resource", async () => {
      const state = new MemoryStateBackend({
        orders: record("orders", Bus.type, { name: "orders" }, []),
        shop: record("shop", Bus.type, { name: "shop" }, []),
        rule: record("rule", Rule.type, { name: "rule", parent: "orders" }, [
          "orders",
        ]),
      });
      const orders = new Bus("orders", {
        config: { name: "orders-2" } as any,
      });
      const shop = new Bus("shop", { config: { name: "shop" } as any });
      const rule = child(Rule, "rule", shop);

      const plan = await createPlan({
        resources: [orders, shop, rule],
        state,
        driftDetection: false,
      });

      expect(plan.nodes[2]).toMatchObject({
        id: "rule",
        decision: "replace",
        replacedDependency: "orders",
      });
    });

    it("once, for a dependent of several replaced resources", async () => {
      const state = new MemoryStateBackend({
        a: record("a", Bus.type, { name: "a" }, []),
        b: record("b", Bus.type, { name: "b" }, []),
        rule: record("rule", Rule.type, { name: "rule", parent: "a" }, [
          "a",
          "b",
        ]),
      });
      const a = new Bus("a", { config: { name: "a-2" } as any });
      const b = new Bus("b", { config: { name: "b-2" } as any });
      const rule = child(Rule, "rule", a);
      rule.dependOn(b);

      const plan = await createPlan({
        resources: [a, b, rule],
        state,
        driftDetection: false,
      });

      expect(plan.nodes.map((node) => node.decision)).toEqual([
        "replace",
        "replace",
        "replace",
      ]);
      expect(plan.nodes[2]).toMatchObject({ replacedDependency: "a" });
    });

    it("when an unknown field may force the replacement", async () => {
      const state = new MemoryStateBackend({
        zone: record("zone", Zone.type, { name: "eu" }, []),
        bus: record("bus", ZoneBus.type, { name: "eu" }, ["zone"]),
        rule: record("rule", Rule.type, { name: "rule", parent: "eu" }, [
          "bus",
        ]),
      });
      const zone = new Zone("zone", { config: { name: "us" } as any });
      const bus = new ZoneBus("bus", { dependencies: { zone } } as any);
      const rule = child(Rule, "rule", bus);

      const plan = await createPlan({
        resources: [zone, bus, rule],
        state,
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({ id: "zone", decision: "replace" }),
        expect.objectContaining({
          id: "bus",
          decision: "replace",
          replaceFields: [{ name: "name", known: false }],
        }),
        expect.objectContaining({
          id: "rule",
          decision: "replace",
          replacedDependency: "bus",
        }),
      ]);
    });

    it("through an orphan in the cascade", async () => {
      const state = new MemoryStateBackend({
        bus: record("bus", Bus.type, { name: "orders" }, []),
        "old-rule": record(
          "old-rule",
          Rule.type,
          { name: "old-rule", parent: "orders" },
          ["bus"],
        ),
        target: record(
          "target",
          Target.type,
          { name: "target", parent: "old-rule" },
          ["old-rule"],
        ),
      });
      const bus = new Bus("bus", { config: { name: "shop" } as any });
      const rule = child(Rule, "rule", bus);
      const target = child(Target, "target", rule);

      const plan = await createPlan({
        resources: [bus, rule, target],
        state,
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({ id: "bus", decision: "replace" }),
        expect.objectContaining({ id: "rule", decision: "create" }),
        expect.objectContaining({
          id: "target",
          decision: "replace",
          replacedDependency: "bus",
        }),
        expect.objectContaining({ id: "old-rule", decision: "delete-orphan" }),
      ]);
    });

    it("treats an orphan with no registered class as not blocking the delete", async () => {
      const state = new MemoryStateBackend({
        bus: record("bus", Bus.type, { name: "orders" }, []),
        "old-rule": record(
          "old-rule",
          Stray.type,
          { name: "old-rule", parent: "orders" },
          ["bus"],
        ),
      });
      const bus = new Bus("bus", { config: { name: "shop" } as any });

      const plan = await createPlan({
        resources: [bus, child(Rule, "rule", bus)],
        state,
        driftDetection: false,
      });

      expect(plan.nodes.map(({ id, decision }) => ({ id, decision }))).toEqual([
        { id: "bus", decision: "replace" },
        { id: "rule", decision: "create" },
        { id: "old-rule", decision: "delete-orphan" },
      ]);
    });
  });

  describe("leaves alone fields it cannot compare", () => {
    // Cast: see above.
    const Role = resource({
      type: "test/planner/role-fields",
      provider: "test",
    })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        path: {
          presence: "optional",
          propertyType: "param",
          immutable: true,
          value: v.string(),
        },
        boundary: {
          value: v.string(),
          presence: "optional",
          propertyType: "param",
          immutable: true,
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        read: async () => remote,
        delete: async () => undefined,
      });
    let remote: Record<string, unknown> = {};
    const plan = (config: Record<string, unknown>) =>
      createPlan({
        resources: [new Role("role", { config: config as any })],
        state: new MemoryStateBackend({
          role: {
            version: 1,
            id: "role",
            type: Role.type,
            provider: "test",
            config: {},
            params: { name: "app", boundary: "arn:boundary" },
            output: { name: "app", boundary: "arn:boundary" },
            lastOperation: "create",
            lastOperationAt: "2026-07-22T00:00:00.000Z",
          },
        }),
      });

    it("an optional param left undefined", async () => {
      remote = { name: "app", boundary: "arn:boundary" };
      const result = await plan({
        name: "app",
        path: undefined,
        boundary: "arn:boundary",
      });
      expect(result.nodes[0]).toMatchObject({ decision: "noop" });
    });

    it("a field the read leaves out, or reports for an unset param", async () => {
      remote = { name: "app", path: "/" };
      const result = await plan({ name: "app", boundary: "arn:boundary" });
      expect(result.nodes[0]).toMatchObject({ decision: "noop" });
    });

    it("but replaces on drift in a field both sides have", async () => {
      remote = { name: "app", boundary: "arn:other" };
      const result = await plan({ name: "app", boundary: "arn:boundary" });
      expect(result.nodes[0]).toMatchObject({
        decision: "drift-replace",
        replaceFields: [{ name: "boundary", known: true }],
      });
    });
  });

  it("plans an unknown output ref at its own path, and records the implied edge", async () => {
    // Cast: see above.
    const Queue = resource({ type: "test/planner/queue", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        arn: {
          presence: "required",
          propertyType: "computed",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const Fn = resource({ type: "test/planner/function", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        env: {
          value: v.record(v.string(), v.string()),
          presence: "optional",
          propertyType: "param",
          collect: mergeContributions,
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const queue = new Queue("queue", { config: { name: "orders" } as any });
    const fn = new Fn("fn", { config: { name: "f" } as any });
    fn.contribute({ env: { KEEP: "k" } } as any);
    fn.contribute({ env: { QUEUE: (queue as any).outputRef("arn") } } as any);

    const plan = await createPlan({
      resources: [fn, queue],
      state: new MemoryStateBackend({
        fn: {
          version: 1,
          id: "fn",
          type: Fn.type,
          provider: "test",
          config: {},
          params: { name: "f", env: { KEEP: "k" } },
          output: { name: "f", env: { KEEP: "k" } },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "queue", decision: "create" }),
      expect.objectContaining({
        id: "fn",
        decision: "update",
        params: { name: "f", env: { KEEP: "k", QUEUE: UNKNOWN_AFTER_APPLY } },
        diff: {
          added: { env: { QUEUE: UNKNOWN_AFTER_APPLY } },
          deleted: {},
          updated: {},
        },
        dependsOn: ["queue"],
      }),
    ]);
  });

  describe("value validation", () => {
    const Fn = resource<{
      Key: { name: string };
      CreateParams: { name: string; memory: number };
      UpdateParams: { memory: number };
      ReadResult: {};
    }>({ type: "test/planner/validated-fn", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          value: v.string(),
          primaryKey: true,
          immutable: true,
        },
        memory: {
          presence: "required",
          propertyType: "param",
          value: v.pipe(v.number(), v.integer()),
        },
      })
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        read: async () => remote,
        delete: async () => undefined,
        deriveParams: () => ({ memory }),
      });
    let memory = 128;
    let remote: Record<string, unknown> = {};
    const state = () =>
      new MemoryStateBackend({
        fn: {
          version: 1,
          id: "fn",
          type: Fn.type,
          provider: "test",
          config: {},
          params: { name: "fn", memory: 128 },
          output: { name: "fn", memory: 128 },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      });

    it("rejects a known value that fails its validator", async () => {
      memory = 1.5;
      const plan = createPlan({
        resources: [new Fn("fn", { config: { name: "fn" } })],
        state: state(),
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        resourceId: "fn",
        field: "memory",
        point: "plan",
      });
    });

    it("rejects an invalid known value next to an unknown output ref", async () => {
      // Cast: see above.
      const Queue = resource({
        type: "test/planner/validated-queue",
        provider: "test",
      })
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            primaryKey: true,
            value: v.string(),
          },
          arn: {
            presence: "required",
            propertyType: "computed",
            value: v.string(),
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          delete: async () => undefined,
        });
      const Env = resource({
        type: "test/planner/validated-env",
        provider: "test",
      })
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            primaryKey: true,
            value: v.string(),
          },
          env: {
            value: v.record(v.string(), v.string()),
            presence: "optional",
            propertyType: "param",
            collect: mergeContributions,
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          delete: async () => undefined,
        });
      const queue = new Queue("queue", { config: { name: "orders" } as any });
      const env = new Env("env", { config: { name: "env" } as any });
      env.contribute({
        env: { QUEUE: (queue as any).outputRef("arn") },
      } as any);
      env.contribute({ env: { PORT: 8080 } } as any);

      const plan = createPlan({
        resources: [env, queue],
        state: new MemoryStateBackend(),
        driftDetection: false,
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        resourceId: "env",
        field: "env",
        point: "plan",
        issues: [expect.stringMatching(/^PORT: Invalid type/)],
      });
    });

    it("rejects a malformed read rather than planning drift from it", async () => {
      memory = 128;
      remote = { name: "fn", memory: "128" };
      const plan = createPlan({
        resources: [new Fn("fn", { config: { name: "fn" } })],
        state: state(),
      });
      await expect(plan).rejects.toMatchObject({
        name: "ValueValidationError",
        field: "memory",
        point: "read",
      });
    });
  });
});
