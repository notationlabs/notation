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

  it("plans a create for a creating record without a read, and notes that it may take over an existing resource", async () => {
    const TestResource = resource({
      type: "test/planner/creating",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new Error("a creating record is not read at plan");
        },
        delete: async () => undefined,
      });
    const state = new MemoryStateBackend({
      creating: {
        version: 1,
        id: "creating",
        type: TestResource.type,
        provider: "test",
        config: {},
        params: {},
        output: {},
        lastOperation: "creating",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    });

    const plan = await createPlan({
      resources: [new TestResource("creating"), new TestResource("new")],
      state,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "creating",
        decision: "create",
        mayTakeOver: true,
      }),
      expect.not.objectContaining({ mayTakeOver: true }),
    ]);
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

  describe("rejectChange", () => {
    const Store = resource<{
      Key: { name: string };
      CreateParams: { name: string; tables: string[] };
      UpdateParams: { tables: string[] };
      ReadResult: {};
    }>({ type: "test/planner/guarded", provider: "test" })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          immutable: true,
          value: v.string(),
        },
        tables: {
          presence: "required",
          propertyType: "param",
          value: v.array(v.string()),
        },
      })
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        rejectChange: (previous, desired) => {
          const dropped = (previous.tables ?? []).filter(
            (table) => !desired?.tables.includes(table),
          );
          return dropped.length > 0
            ? `would drop ${dropped.join(", ")}`
            : undefined;
        },
      });
    const state = () =>
      new MemoryStateBackend({
        store: {
          version: 1,
          id: "store",
          type: Store.type,
          provider: "test",
          config: {},
          params: { name: "app", tables: ["a", "b"] },
          output: { name: "app", tables: ["a", "b"] },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      });

    it("fails the plan with the message, and allows a change it returns nothing for", async () => {
      const plan = (tables: string[]) =>
        createPlan({
          resources: [new Store("store", { config: { name: "app", tables } })],
          state: state(),
          driftDetection: false,
        });

      await expect(plan(["a"])).rejects.toThrow("store: would drop b");
      expect((await plan(["a", "b", "c"])).nodes[0]).toMatchObject({
        decision: "update",
      });
    });

    it("fails the plan for an orphan whose delete it rejects", async () => {
      await expect(
        createPlan({
          resources: [],
          state: state(),
          driftDetection: false,
          registry: new Map([[Store.type, Store]]),
        }),
      ).rejects.toThrow("store: would drop a, b");
    });

    it("allows an orphan that an orphan with no class keeps in place", async () => {
      const store = await state().get("store");
      const plan = await createPlan({
        resources: [],
        state: new MemoryStateBackend({
          store: store!,
          holder: {
            version: 1,
            id: "holder",
            type: "test/planner/unregistered",
            provider: "test",
            config: {},
            params: {},
            output: {},
            dependsOn: ["store"],
            lastOperation: "create",
            lastOperationAt: "2026-07-22T00:00:00.000Z",
          },
        }),
        driftDetection: false,
        registry: new Map([[Store.type, Store]]),
      });
      expect(plan.nodes.map((node) => node.decision)).toEqual([
        "delete-orphan",
        "delete-orphan",
      ]);
    });

    describe("passes whether deploy replaces the resource", () => {
      // Each rejectChange records the name and the replace flag it receives.
      const seen: string[] = [];
      const name = {
        presence: "required",
        propertyType: "param",
        primaryKey: true,
        immutable: true,
        value: v.string(),
      } as const;
      const Parent = resource<{
        Key: { name: string };
        CreateParams: { name: string; region: string };
        UpdateParams: {};
        ReadResult: {};
      }>({ type: "test/planner/guarded-parent", provider: "test" })
        .defineSchema({
          name,
          region: {
            presence: "required",
            propertyType: "param",
            immutable: true,
            value: v.string(),
          },
        })
        .defineOperations({
          create: async () => undefined,
          delete: async () => undefined,
          rejectChange: (previous, _desired, { replace }) =>
            void seen.push(`${previous.name}:${replace}`),
        });
      // Rejects its replacement. Blocks the delete of its parent, so deploy
      // deletes it and creates it again when the parent is replaced.
      const Child = resource<{
        Key: { name: string };
        CreateParams: { name: string; parent: string };
        UpdateParams: { parent: string };
        ReadResult: {};
      }>({
        type: "test/planner/guarded-child",
        provider: "test",
        blocksDeleteOf: [Parent.type],
      })
        .defineSchema({
          name,
          parent: {
            presence: "required",
            propertyType: "param",
            value: v.string(),
          },
        })
        .defineOperations({
          create: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
          rejectChange: (previous, _desired, { replace }) => {
            seen.push(`${previous.name}:${replace}`);
            return replace ? `${previous.name} would be replaced` : undefined;
          },
        })
        .requireDependencies<{ parent: BaseResource }>()
        .deriveParams(({ deps }) => ({
          parent: (deps.parent.output as { name: string }).name,
        }));
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
      const declare = (region: string) => {
        const parent = new Parent("parent", {
          config: { name: "p", region },
        });
        const child = new Child("child", {
          config: { name: "c" },
          dependencies: { parent },
        });
        return [parent, child];
      };

      it("for a change of a field that is not a key, and for a cascade", async () => {
        seen.length = 0;
        const state = new MemoryStateBackend({
          parent: record(
            "parent",
            Parent.type,
            { name: "p", region: "eu" },
            [],
          ),
          child: record("child", Child.type, { name: "c", parent: "p" }, [
            "parent",
          ]),
        });

        await expect(
          createPlan({
            resources: declare("us"),
            state,
            driftDetection: false,
          }),
        ).rejects.toThrow("child: c would be replaced");
        expect(seen).toEqual(["p:true", "c:false", "c:true"]);
      });
    });
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
      // None of them has a generated name, and a dependent deleted in a
      // cascade is deleted before it is created again.
      expect(
        Object.fromEntries(
          plan.nodes
            .filter((node) => node.replaceOrder)
            .map((node) => [node.id, node.replaceOrder]),
        ),
      ).toEqual({
        bus: "delete-first",
        rule: "delete-first",
        target: "delete-first",
      });
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

  describe("output refs", () => {
    // Cast: see above.
    const defineQueue = (read?: () => Promise<{}>) =>
      resource({ type: "test/planner/queue", provider: "test" })
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
          ...(read ? { read } : {}),
          delete: async () => undefined,
        });
    const Queue = defineQueue(async () => ({}));
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
        queueArn: {
          presence: "optional",
          propertyType: "param",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });

    it("plans an unknown output ref at its own path, and records the implied edge", async () => {
      const queue = new Queue("queue", { config: { name: "orders" } as any });
      const fn = new Fn("fn", { config: { name: "f" } as any });
      fn.contribute({ env: { KEEP: "k" } } as any);
      fn.contribute({
        env: { QUEUE: (queue as any).outputRef("arn") },
      } as any);

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

    it("plans a required output missing from a dependency's state as unknown", async () => {
      const queue = new Queue("queue", { config: { name: "orders" } as any });
      const fn = new Fn("fn", {
        config: {
          name: "f",
          queueArn: (queue as any).outputRef("arn"),
        } as any,
      });

      const plan = await createPlan({
        resources: [queue, fn],
        state: new MemoryStateBackend({
          queue: record("queue", Queue.type, { name: "orders" }),
          fn: record("fn", Fn.type, { name: "f", queueArn: "arn:q" }),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toMatchObject([
        { id: "queue", decision: "noop" },
        {
          id: "fn",
          decision: "update",
          params: { name: "f", queueArn: UNKNOWN_AFTER_APPLY },
          dependsOn: ["queue"],
        },
      ]);
    });

    it("fails when a dependency with no read lacks a required output in state", async () => {
      const QueueWithoutRead = defineQueue();
      const queue = new QueueWithoutRead("queue", {
        config: { name: "orders" } as any,
      });
      const fn = new Fn("fn", {
        config: {
          name: "f",
          queueArn: (queue as any).outputRef("arn"),
        } as any,
      });

      const error = await createPlan({
        resources: [queue, fn],
        state: new MemoryStateBackend({
          queue: record("queue", QueueWithoutRead.type, { name: "orders" }),
          fn: record("fn", Fn.type, { name: "f", queueArn: "arn:q" }),
        }),
        driftDetection: false,
      }).catch((e) => e);

      expect(error).toMatchObject({
        name: "SchemaStructureError",
        fields: ["arn"],
      });
    });

    it("fails when a resource with no read and no dependents lacks a required output in state", async () => {
      const QueueWithoutRead = defineQueue();
      const queue = new QueueWithoutRead("queue", {
        config: { name: "orders" } as any,
      });

      const error = await createPlan({
        resources: [queue],
        state: new MemoryStateBackend({
          queue: record("queue", QueueWithoutRead.type, { name: "orders" }),
        }),
        driftDetection: false,
      }).catch((e) => e);

      expect(error).toMatchObject({
        name: "SchemaStructureError",
        fields: ["arn"],
        message: expect.stringContaining("Remove the resource from the code"),
      });
    });
  });

  describe("a resource with no read that lacks a required output in state", () => {
    // Cast: see above.
    const Queue = resource({
      type: "test/planner/unread-queue",
      provider: "test",
    })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
          immutable: true,
        },
        size: {
          presence: "optional",
          propertyType: "param",
          value: v.number(),
        },
        arn: {
          presence: "required",
          propertyType: "computed",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    // Blocks the delete of its queue, so deploy deletes it before it replaces
    // the queue.
    const Subscription = resource({
      type: "test/planner/unread-subscription",
      provider: "test",
      blocksDeleteOf: [Queue.type],
    })
      .defineSchema({
        name: {
          presence: "required",
          propertyType: "param",
          primaryKey: true,
          value: v.string(),
        },
        queueArn: {
          presence: "optional",
          propertyType: "param",
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
        update: async () => undefined,
        delete: async () => undefined,
      });
    const record = (
      id: string,
      type: string,
      params: DurableObject,
      dependsOn: string[] = [],
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
    const planQueue = (config: DurableObject) =>
      createPlan({
        resources: [new Queue("queue", { config } as any)],
        state: new MemoryStateBackend({
          queue: record("queue", Queue.type, { name: "orders", size: 1 }),
        }),
        driftDetection: false,
      });

    it("fails when deploy would leave it unchanged", async () => {
      const error = await planQueue({ name: "orders", size: 1 }).catch(
        (e) => e,
      );
      expect(error).toMatchObject({
        name: "SchemaStructureError",
        fields: ["arn"],
      });
    });

    it("fails when deploy would update it", async () => {
      const error = await planQueue({ name: "orders", size: 2 }).catch(
        (e) => e,
      );
      expect(error).toMatchObject({
        name: "SchemaStructureError",
        fields: ["arn"],
      });
    });

    it("plans a replace, and its dependents against unknown outputs", async () => {
      const queue = new Queue("queue", {
        config: { name: "renamed", size: 1 },
      } as any);
      const subscription = new Subscription("subscription", {
        config: { name: "s", queueArn: (queue as any).outputRef("arn") },
      } as any);

      const plan = await createPlan({
        resources: [queue, subscription],
        state: new MemoryStateBackend({
          queue: record("queue", Queue.type, { name: "orders", size: 1 }),
          // The subscription's record lacks its own arn too. Deploy deletes
          // it before it replaces the queue, and creates it again.
          subscription: record(
            "subscription",
            Subscription.type,
            { name: "s", queueArn: "arn:q" },
            ["queue"],
          ),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toMatchObject([
        { id: "queue", decision: "replace" },
        {
          id: "subscription",
          decision: "replace",
          replacedDependency: "queue",
          params: { name: "s", queueArn: UNKNOWN_AFTER_APPLY },
        },
      ]);
    });

    it("plans a possible replace when an immutable param takes a replaced dependency's output", async () => {
      // A type with no read, whose `target` is immutable.
      const Attachment = resource({
        type: "test/planner/unread-attachment",
        provider: "test",
      })
        .defineSchema({
          name: {
            presence: "required",
            propertyType: "param",
            primaryKey: true,
            value: v.string(),
          },
          target: {
            presence: "required",
            propertyType: "param",
            value: v.string(),
            immutable: true,
          },
          arn: {
            presence: "required",
            propertyType: "computed",
            value: v.string(),
          },
        } as any)
        .defineOperations({
          create: async () => undefined,
          update: async () => undefined,
          delete: async () => undefined,
        });
      const queue = new Queue("queue", {
        config: { name: "renamed", size: 1 },
      } as any);
      const attachment = new Attachment("attachment", {
        config: { name: "a", target: (queue as any).outputRef("arn") },
      } as any);

      const plan = await createPlan({
        resources: [queue, attachment],
        state: new MemoryStateBackend({
          queue: record("queue", Queue.type, {
            name: "orders",
            size: 1,
            arn: "arn:q",
          }),
          // The attachment's record lacks its own arn.
          attachment: record(
            "attachment",
            Attachment.type,
            { name: "a", target: "arn:q" },
            ["queue"],
          ),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toMatchObject([
        { id: "queue", decision: "replace" },
        {
          id: "attachment",
          decision: "replace",
          replaceFields: [{ name: "target", known: false }],
          params: { name: "a", target: UNKNOWN_AFTER_APPLY },
        },
      ]);
    });
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

describe("dependency cycles", () => {
  const schema = {
    name: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
    bindings: {
      propertyType: "param",
      presence: "optional",
      value: v.array(v.string()),
      collect: (items: string[][]) => items.flat(),
    },
  } as any;
  const Worker = resource({ type: "test/planner/worker", provider: "test" })
    .defineSchema(schema)
    .defineOperations({
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    });

  const pair = () => {
    const a = new Worker("a", { config: { name: "a" } as any });
    const b = new Worker("b", { config: { name: "b" } as any });
    a.contribute({ bindings: [b.outputRef("name")] } as any);
    b.contribute({ bindings: [a.outputRef("name")] } as any);
    return [a, b];
  };

  const record = (name: string, bindings: string[]) => ({
    version: 1,
    id: name,
    type: Worker.type,
    provider: "test",
    config: { name },
    params: { name, bindings },
    output: { name, bindings },
    dependsOn: [name === "a" ? "b" : "a"],
    lastOperation: "update" as const,
    lastOperationAt: "2026-07-22T00:00:00.000Z",
  });

  it("plans a new cycle as creates, with the placeholder marked and peer outputs unknown", async () => {
    const plan = await createPlan({
      resources: pair(),
      state: new MemoryStateBackend(),
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "a",
        decision: "create",
        placeholder: true,
        cycle: ["b"],
        params: { name: "a", bindings: [UNKNOWN_AFTER_APPLY] },
      }),
      expect.objectContaining({
        id: "b",
        decision: "create",
        cycle: ["a"],
        params: { name: "b", bindings: [UNKNOWN_AFTER_APPLY] },
      }),
    ]);
    expect(plan.nodes[1]).not.toHaveProperty("placeholder");
  });

  it("marks a placeholder that no longer exists, as deploy creates it again without its contributions", async () => {
    const Gone = resource({
      type: "test/planner/gone-worker",
      provider: "test",
    })
      .defineSchema(schema)
      .defineOperations({
        create: async () => undefined,
        read: async () => {
          throw new ResourceNotFoundError("not found");
        },
        update: async () => undefined,
        delete: async () => undefined,
      });
    const a = new Gone("a", { config: { name: "a" } as any });
    const b = new Worker("b", { config: { name: "b" } as any });
    a.contribute({ bindings: [b.outputRef("name")] } as any);
    b.contribute({ bindings: [a.outputRef("name")] } as any);

    const plan = await createPlan({
      resources: [a, b],
      state: new MemoryStateBackend({
        a: { ...record("a", ["b"]), type: Gone.type },
        b: record("b", ["a"]),
      }),
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "a",
      decision: "drift-recreate",
      placeholder: true,
    });
  });

  it("plans a deployed cycle with the outputs of every member from state", async () => {
    const plan = await createPlan({
      resources: pair(),
      state: new MemoryStateBackend({
        a: record("a", ["b"]),
        b: record("b", ["a"]),
      }),
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "a", decision: "noop", cycle: ["b"] }),
      expect.objectContaining({ id: "b", decision: "noop", cycle: ["a"] }),
    ]);
    expect(plan.nodes[0]).not.toHaveProperty("placeholder");
  });

  it("plans a member that comes before a replaced member against the unknown output of the replacement", async () => {
    const [a, b] = pair();
    (b as any).config.name = "b2";
    const plan = await createPlan({
      resources: [a!, b!],
      state: new MemoryStateBackend({
        a: record("a", ["b"]),
        b: record("b", ["a"]),
      }),
    });

    expect(plan.nodes[0]).toMatchObject({
      id: "a",
      decision: "update",
      params: { name: "a", bindings: [UNKNOWN_AFTER_APPLY] },
    });
  });

  it("names the dependents whose references a replacement breaks, for a type that takes dependents in its delete", async () => {
    const Forced = resource({
      type: "test/planner/forced-worker",
      provider: "test",
      deleteTakesDependents: true,
    })
      .defineSchema(schema)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      });
    const worker = (id: string, name = id) =>
      new Forced(id, { config: { name } as any });
    const a = worker("a");
    const b = worker("b", "b2");
    const c = worker("c");
    a.contribute({ bindings: [b.outputRef("name")] } as any);
    b.contribute({ bindings: [a.outputRef("name")] } as any);
    c.contribute({ bindings: [b.outputRef("name")] } as any);
    const forced = (name: string, bindings: string[]) => ({
      ...record(name, bindings),
      type: Forced.type,
      dependsOn: bindings,
    });

    const plan = await createPlan({
      resources: [a, b, c],
      state: new MemoryStateBackend({
        a: forced("a", ["b"]),
        b: forced("b", ["a"]),
        c: forced("c", ["b"]),
        gone: forced("gone", ["b"]),
      }),
    });

    expect(plan.nodes.find(({ id }) => id === "b")).toMatchObject({
      decision: "replace",
      brokenDependents: ["a", "c"],
    });
    expect(plan.nodes.find(({ id }) => id === "a")).not.toHaveProperty(
      "brokenDependents",
    );
  });

  it("names no dependents for a replaced resource of a type that does not take dependents in its delete", async () => {
    const [a, b] = pair();
    (b as any).config.name = "b2";
    const plan = await createPlan({
      resources: [a!, b!],
      state: new MemoryStateBackend({
        a: record("a", ["b"]),
        b: record("b", ["a"]),
      }),
    });

    expect(plan.nodes.find(({ id }) => id === "b")).not.toHaveProperty(
      "brokenDependents",
    );
  });
});

describe("createPlan with a generated physical name", () => {
  const Queue = resource({ type: "test/planner/named", provider: "test" })
    // Cast: a resource declared without API types constrains every schema
    // key to be a key of an `any` API schema, which no named key satisfies.
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
      delete: async () => undefined,
    });
  const queue = (id: string, config: Record<string, unknown>): BaseResource =>
    new Queue(id, { config: config as any });
  const record = (
    id: string,
    params: Record<string, DurableObject[string]>,
    lastOperation: "create" | "creating" = "create",
  ) => ({
    version: 1,
    id,
    type: Queue.type,
    provider: "test",
    config: {},
    params,
    output: { name: params.name! },
    lastOperation,
    lastOperationAt: "2026-07-22T00:00:00.000Z",
  });
  const name = "shop--prod--orders-1a2b3c4d";

  it("plans a noop with the name in the state record", async () => {
    const plan = await createPlan({
      resources: [queue("orders", { path: "/" })],
      state: new MemoryStateBackend({
        orders: record("orders", { name, path: "/" }),
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "noop",
        params: { name, path: "/" },
      }),
    ]);
  });

  it("throws when deriveParams supplies the name", async () => {
    const Derived = resource({ type: "test/planner/derived", provider: "test" })
      // Cast: as for Queue.
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          primaryKey: true,
          value: v.string(),
          physicalName: { maxLength: 64 },
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{}>()
      .deriveParams(({ id }) => ({ name: `derived-${id}` }));

    await expect(
      createPlan({
        resources: [new Derived("orders", { config: {} as any })],
        state: new MemoryStateBackend({}),
        driftDetection: false,
      }),
    ).rejects.toThrow(
      'Resource "orders" (test/planner/derived): the params supply "name", which has physicalName in the schema. Deploy generates a physicalName param from the resource ID, so neither config nor deriveParams can supply it.',
    );
  });

  it("plans a create with an unknown name for a resource with no record", async () => {
    const orders = queue("orders", { path: "/" });
    const mirror = queue("mirror", { path: "/" });
    mirror.config.target = orders.outputRef("name");

    const plan = await createPlan({
      resources: [orders, mirror],
      state: new MemoryStateBackend({}),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "create",
        params: { name: UNKNOWN_AFTER_APPLY, path: "/" },
      }),
      expect.objectContaining({
        id: "mirror",
        decision: "create",
        params: {
          name: UNKNOWN_AFTER_APPLY,
          path: "/",
          target: UNKNOWN_AFTER_APPLY,
        },
      }),
    ]);
  });

  it("plans a create with the name in a creating record", async () => {
    const plan = await createPlan({
      resources: [queue("orders", { path: "/" })],
      state: new MemoryStateBackend({
        orders: record("orders", { name, path: "/" }, "creating"),
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "create",
        mayTakeOver: true,
        params: { name, path: "/" },
      }),
    ]);
  });

  it("plans a replace with an unknown name, and an update of a dependent that takes the name", async () => {
    const orders = queue("orders", { path: "/new/" });
    const mirror = queue("mirror", { path: "/" });
    mirror.config.target = orders.outputRef("name");
    const mirrorName = "shop--prod--mirror-5e6f7a8b";

    const plan = await createPlan({
      resources: [orders, mirror],
      state: new MemoryStateBackend({
        orders: record("orders", { name, path: "/" }),
        mirror: record("mirror", { name: mirrorName, path: "/", target: name }),
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "replace",
        replaceOrder: "create-first",
        params: { name: UNKNOWN_AFTER_APPLY, path: "/new/" },
      }),
      expect.objectContaining({
        id: "mirror",
        decision: "update",
        params: { name: mirrorName, path: "/", target: UNKNOWN_AFTER_APPLY },
      }),
    ]);
  });

  it("does not plan the delete of a dependent that blocks the delete of a resource that it replaces create-first", async () => {
    const Rule = resource({
      type: "test/planner/named-rule",
      provider: "test",
      blocksDeleteOf: [Queue.type],
    })
      // Cast: as for Queue.
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          primaryKey: true,
          value: v.string(),
        },
        parent: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ parent: BaseResource }>()
      .deriveParams(({ deps }) => ({
        parent: (deps.parent.output as any).name,
      }));
    const orders = queue("orders", { path: "/new/" });
    const rule = new Rule("rule", {
      config: { name: "rule" } as any,
      dependencies: { parent: orders },
    });

    const plan = await createPlan({
      resources: [orders, rule],
      state: new MemoryStateBackend({
        orders: record("orders", { name, path: "/" }),
        rule: {
          ...record("rule", { name: "rule", parent: name }),
          type: Rule.type,
          dependsOn: ["orders"],
        },
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        id: "orders",
        decision: "replace",
        replaceOrder: "create-first",
      }),
      expect.objectContaining({
        id: "rule",
        decision: "update",
        params: { name: "rule", parent: UNKNOWN_AFTER_APPLY },
      }),
    ]);
    expect(plan.nodes[1]).not.toHaveProperty("replacedDependency");
    expect(plan.nodes[1]).not.toHaveProperty("replaceOrder");
  });

  it("plans a delete for each retired instance in state, just before the delete of an orphan", async () => {
    const retired = (instanceName: string, retiredAt: string) => ({
      config: {},
      params: { name: instanceName, path: "/" },
      output: { name: instanceName },
      dependsOn: ["role"],
      retiredAt,
    });
    const first = retired(
      "shop--prod--orders-00000001",
      "2026-07-20T00:00:00.000Z",
    );
    const second = retired(
      "shop--prod--orders-00000002",
      "2026-07-21T00:00:00.000Z",
    );
    const old = retired("shop--prod--old-00000003", "2026-07-21T00:00:00.000Z");

    const plan = await createPlan({
      resources: [queue("orders", { path: "/" })],
      state: new MemoryStateBackend({
        orders: {
          ...record("orders", { name, path: "/" }),
          retired: [first, second],
        },
        old: {
          ...record("old", { name: "shop--prod--old-00000004", path: "/" }),
          retired: [old],
        },
      }),
      driftDetection: false,
    });

    expect(plan.nodes).toEqual([
      expect.objectContaining({ id: "orders", decision: "noop" }),
      {
        id: "old",
        type: Queue.type,
        decision: "delete-retired",
        retiredAt: old.retiredAt,
        params: old.params,
        dependsOn: ["role"],
      },
      expect.objectContaining({ id: "old", decision: "delete-orphan" }),
      expect.objectContaining({
        id: "orders",
        decision: "delete-retired",
        params: first.params,
      }),
      expect.objectContaining({
        id: "orders",
        decision: "delete-retired",
        params: second.params,
      }),
    ]);
  });

  it("plans an update with the recorded name when a dependency has no output yet", async () => {
    const Fn = resource({ type: "test/planner/named-fn", provider: "test" })
      // Cast: as for Queue.
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          primaryKey: true,
          value: v.string(),
          physicalName: { maxLength: 64 },
        },
        role: {
          propertyType: "param",
          presence: "required",
          value: v.string(),
        },
      } as any)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      })
      .requireDependencies<{ role: BaseResource }>()
      .deriveParams(({ deps }) => ({ role: (deps.role.output as any).name }));
    const role = queue("role", { path: "/" });

    const plan = await createPlan({
      resources: [role, new Fn("fn", { dependencies: { role } })],
      state: new MemoryStateBackend({
        fn: {
          ...record("fn", { name, role: "old-role" }),
          type: Fn.type,
        },
      }),
      driftDetection: false,
    });

    expect(plan.nodes[1]).toMatchObject({
      id: "fn",
      decision: "update",
      params: { name, role: UNKNOWN_AFTER_APPLY },
    });
  });

  it("throws when config supplies the name", async () => {
    await expect(
      createPlan({
        resources: [queue("orders", { name: "orders", path: "/" })],
        state: new MemoryStateBackend({}),
        driftDetection: false,
      }),
    ).rejects.toThrow(
      'Resource "orders" (test/planner/named): the params supply "name", which has physicalName in the schema.',
    );
  });
});

describe("createPlan with refs that add no dependency", () => {
  const Worker = resource({ type: "test/planner/worker", provider: "test" })
    // Cast: as for Queue in "createPlan with a generated physical name".
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
      bindings: {
        propertyType: "param",
        presence: "optional",
        value: v.array(v.unknown()),
        collect: (items: unknown[][]) => items.flat(),
      },
      sources: {
        propertyType: "param",
        presence: "optional",
        value: v.array(v.string()),
        // A ~state ref to a target with no record resolves to undefined.
        collect: (items: (string | undefined)[][]) =>
          items.flat().filter((name) => name !== undefined),
      },
    } as any)
    .defineOperations({
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    });
  const worker = (id: string, path = "/"): BaseResource =>
    new Worker(id, { config: { path } as any });
  const record = (
    id: string,
    params: Record<string, DurableObject[string]>,
  ) => ({
    version: 1,
    id,
    type: Worker.type,
    provider: "test",
    config: {},
    params,
    output: params,
    lastOperation: "create" as const,
    lastOperationAt: "2026-07-22T00:00:00.000Z",
  });
  const hostName = "shop--prod--host-1a2b3c4d";
  const binderName = "shop--prod--binder-5e6f7a8b";

  describe("a ref to the resource's own physicalName param", () => {
    const selfBound = (id: string, path = "/") => {
      const self = worker(id, path);
      self.contribute({
        bindings: [{ name: "SELF", service: self.outputRef("name") }],
      } as any);
      return self;
    };

    it("plans a create with the name unknown in both params, and no cycle", async () => {
      const plan = await createPlan({
        resources: [selfBound("host")],
        state: new MemoryStateBackend({}),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        {
          id: "host",
          type: Worker.type,
          decision: "create",
          params: {
            name: UNKNOWN_AFTER_APPLY,
            path: "/",
            bindings: [{ name: "SELF", service: UNKNOWN_AFTER_APPLY }],
          },
          dependsOn: [],
        },
      ]);
    });

    it("plans a noop with the recorded name in both params", async () => {
      const plan = await createPlan({
        resources: [selfBound("host")],
        state: new MemoryStateBackend({
          host: record("host", {
            name: hostName,
            path: "/",
            bindings: [{ name: "SELF", service: hostName }],
          }),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          decision: "noop",
          params: {
            name: hostName,
            path: "/",
            bindings: [{ name: "SELF", service: hostName }],
          },
        }),
      ]);
    });

    it("plans a replace with the name unknown in both params", async () => {
      const plan = await createPlan({
        resources: [selfBound("host", "/new/")],
        state: new MemoryStateBackend({
          host: record("host", {
            name: hostName,
            path: "/",
            bindings: [{ name: "SELF", service: hostName }],
          }),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          decision: "replace",
          params: {
            name: UNKNOWN_AFTER_APPLY,
            path: "/new/",
            bindings: [{ name: "SELF", service: UNKNOWN_AFTER_APPLY }],
          },
        }),
      ]);
    });
  });

  describe("a ~state ref", () => {
    // The binder depends on the host, and the host reads the binder's name
    // from state, as a Durable Object host reads its transfer sources.
    const hostAndBinder = () => {
      const host = worker("host");
      const binder = worker("binder");
      binder.contribute({
        bindings: [{ name: "HOST", service: host.outputRef("name") }],
      } as any);
      host.contribute({
        sources: [binder["~state"].outputRef("name")],
      } as any);
      return [host, binder];
    };

    it("plans with no value when the target has no record, and adds no dependency", async () => {
      const plan = await createPlan({
        resources: hostAndBinder(),
        state: new MemoryStateBackend({}),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          id: "host",
          decision: "create",
          params: { name: UNKNOWN_AFTER_APPLY, path: "/", sources: [] },
          dependsOn: [],
        }),
        expect.objectContaining({
          id: "binder",
          decision: "create",
          dependsOn: ["host"],
        }),
      ]);
      expect(plan.nodes[0]).not.toHaveProperty("cycle");
    });

    it("plans with the output in the target's record", async () => {
      const plan = await createPlan({
        resources: hostAndBinder(),
        state: new MemoryStateBackend({
          host: record("host", { name: hostName, path: "/", sources: [] }),
          binder: record("binder", {
            name: binderName,
            path: "/",
            bindings: [{ name: "HOST", service: hostName }],
          }),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({
          id: "host",
          decision: "update",
          params: { name: hostName, path: "/", sources: [binderName] },
        }),
        expect.objectContaining({ id: "binder", decision: "noop" }),
      ]);
    });

    it("plans with the recorded output when the target is replaced", async () => {
      const host = worker("host");
      const binder = worker("binder", "/new/");
      host.contribute({
        sources: [binder["~state"].outputRef("name")],
      } as any);

      const plan = await createPlan({
        resources: [binder, host],
        state: new MemoryStateBackend({
          host: record("host", { name: hostName, path: "/" }),
          binder: record("binder", { name: binderName, path: "/" }),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toEqual([
        expect.objectContaining({ id: "binder", decision: "replace" }),
        expect.objectContaining({
          id: "host",
          decision: "update",
          params: { name: hostName, path: "/", sources: [binderName] },
        }),
      ]);
    });
  });
});
