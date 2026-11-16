import * as v from "valibot";
import {
  credentialSourceResource,
  resource,
  type BaseResource,
  type CredentialSourceReadContext,
} from "@notation/resource";
import { clearSecretValues } from "@notation/utils";
import { beforeEach, describe, expect, it } from "vitest";
import { clearHeldCredentials } from "../src/credentials";
import { createPlan } from "../src/planner";
import { createRuntime } from "./credentials-runtime";

/** The values outside notation, with every version of each key. */
type Outside = {
  values: Map<string, string[]>;
  calls: string[];
  contexts: CredentialSourceReadContext[];
  /** The params and the values that the last update received. */
  updates: { patch: unknown; params: unknown }[];
  /** The entries of a bundle's `Values` that its remote no longer has. */
  lost: Set<string>;
  warning?: string;
};

function createOutside(): Outside {
  return {
    values: new Map(),
    calls: [],
    contexts: [],
    updates: [],
    lost: new Set(),
  };
}

function set(outside: Outside, key: string, value: string) {
  outside.values.set(key, [...(outside.values.get(key) ?? []), value]);
}

function defineResources(outside: Outside) {
  const Stored = credentialSourceResource<{
    Params: { key: string; label?: string };
    Value: string;
  }>({ type: "test/sources/Stored", provider: "test" })
    .defineSchema({
      key: { propertyType: "param", presence: "required", value: v.string() },
      label: {
        propertyType: "param",
        presence: "optional",
        value: v.string(),
      },
      revision: {
        propertyType: "computed",
        presence: "required",
        value: v.string(),
      },
      value: { propertyType: "credential", value: v.string() },
    } as const)
    .defineOperations({
      read: async (params, context) => {
        outside.calls.push(`read ${params.key}`);
        outside.contexts.push(context);
        if (outside.warning) context.warn(outside.warning);
        return { revision: String(outside.values.get(params.key)!.length) };
      },
      loadCredential: async (params, state) => {
        outside.calls.push(`load ${params.key}@${state.revision}`);
        const versions = outside.values.get(params.key)!;
        return { value: versions[Number(state.revision) - 1]! };
      },
    });

  const Secret = resource<{
    Key: { name: string };
    CreateParams: { name: string; Value: string };
    UpdateParams: { Value: string };
    ReadResult: {};
  }>({ type: "test/sources/Secret", provider: "test" })
    .defineSchema({
      name: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        primaryKey: true,
        value: v.string(),
      },
      Value: {
        propertyType: "param",
        presence: "required",
        sensitive: true,
        value: v.string(),
      },
    } as const)
    .defineOperations({
      create: async (params) => {
        outside.calls.push(`create ${params.name}=${params.Value}`);
      },
      update: async (key, patch) => {
        outside.calls.push(`update ${key.name}=${patch.Value}`);
      },
      delete: async (key) => {
        outside.calls.push(`delete ${key.name}`);
      },
    });

  const Bundle = resource<{
    Key: { name: string };
    CreateParams: { name: string; Values: Record<string, string> };
    UpdateParams: { Values: Record<string, string> };
    ReadResult: {};
  }>({ type: "test/sources/Bundle", provider: "test" })
    .defineSchema({
      name: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        primaryKey: true,
        value: v.string(),
      },
      Values: {
        propertyType: "param",
        presence: "required",
        sensitive: true,
        value: v.record(v.string(), v.string()),
      },
    } as const)
    .defineOperations({
      create: async (params) => {
        outside.calls.push(`create ${params.name}`);
      },
      update: async (key, patch, params) => {
        outside.calls.push(`update ${key.name}`);
        outside.updates.push({ patch, params });
      },
      // Returns the markers in params of the entries that the remote has.
      read: async (key, _context, params) => ({
        name: key.name,
        Values: Object.fromEntries(
          Object.entries(params?.Values ?? {}).filter(
            ([name]) => !outside.lost.has(name),
          ),
        ),
      }),
      delete: async () => {},
    });

  return { Stored, Secret, Bundle };
}

type Types = ReturnType<typeof defineResources>;

/** A source for each key, and a secret for each name that takes `key`. */
function declare(
  types: Types,
  {
    key = "STRIPE_KEY",
    label,
    secrets = ["a"],
  }: { key?: string; label?: string; secrets?: string[] } = {},
): BaseResource[] {
  const source = new types.Stored("stripe-key", {
    config: { key, ...(label ? { label } : {}) },
  });
  return [
    source,
    ...secrets.map(
      (name) =>
        new types.Secret(`secret:${name}`, {
          config: { name, Value: source.credentials.value },
        }),
    ),
  ];
}

beforeEach(() => {
  clearHeldCredentials();
  clearSecretValues();
});

describe("a source", () => {
  it("is recorded with its revision, and its value goes to the resource that takes it", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types));

    expect(outside.calls).toEqual([
      "read STRIPE_KEY",
      "load STRIPE_KEY@1",
      "create a=sk_1",
    ]);
    const record = await runtime.state.get("stripe-key");
    expect(record).toMatchObject({
      type: "test/sources/Stored",
      params: { key: "STRIPE_KEY" },
      output: {
        key: "STRIPE_KEY",
        revision: "1",
        value: {
          $credential: {
            resource: "stripe-key",
            name: "value",
            version: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        },
      },
    });
    expect(runtime.dump()).not.toContain("sk_1");
    runtime.close();
  });

  it("is read, and not loaded, by a deploy at the same revision", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));
    outside.calls.length = 0;

    await runtime.nextProcess("second", declare(types));

    expect(outside.calls).toEqual(["read STRIPE_KEY"]);
    runtime.close();
  });

  it("updates every resource that takes it at a new revision", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    set(outside, "STRIPE_KEY", "sk_2");
    outside.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );

    expect(outside.calls).toEqual([
      "read STRIPE_KEY",
      "load STRIPE_KEY@2",
      "update a=sk_2",
      "update b=sk_2",
    ]);
    expect((await runtime.state.get("stripe-key"))!.output.revision).toBe("2");
    runtime.close();
  });

  it("is loaded for a resource added later, and the others are not written", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));
    outside.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );

    expect(outside.calls).toEqual([
      "read STRIPE_KEY",
      "load STRIPE_KEY@1",
      "create b=sk_1",
    ]);
    runtime.close();
  });

  it("is updated and not replaced when a param changes, and the resources that take it are updated", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    set(outside, "OTHER_KEY", "other_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));
    outside.calls.length = 0;

    await runtime.nextProcess("second", declare(types, { key: "OTHER_KEY" }));

    expect(outside.calls).toEqual([
      "read OTHER_KEY",
      "load OTHER_KEY@1",
      "update a=other_1",
    ]);
    expect(runtime.events).toContainEqual(
      expect.objectContaining({
        event: "reconciler.deploy.decision",
        resourceId: "stripe-key",
        decision: "update",
      }),
    );
    runtime.close();
  });

  it("is never loaded when no resource takes it", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types, { secrets: [] }));

    expect(outside.calls).toEqual(["read STRIPE_KEY"]);
    runtime.close();
  });

  it("has its record deleted, and nothing called, when it leaves the code", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: [] }));
    outside.calls.length = 0;

    // Another source keeps the class in the registry, as core's registry
    // from state does.
    await runtime.nextProcess("second", [
      new types.Stored("other", { config: { key: "STRIPE_KEY" } }),
    ]);

    expect(outside.calls).toEqual(["read STRIPE_KEY"]);
    expect(await runtime.state.get("stripe-key")).toBeUndefined();
    runtime.close();
  });

  it("gives read the source's ID, the execution, the deployment and the recorded state", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: [] }));
    await runtime.nextProcess("second", declare(types, { secrets: [] }));

    expect(outside.contexts[0]).toMatchObject({
      id: "stripe-key",
      executionId: "first",
      app: "shop",
      stage: "prod",
      state: undefined,
    });
    expect(outside.contexts[1]).toMatchObject({
      executionId: "second",
      state: { key: "STRIPE_KEY", revision: "1" },
    });
    expect(outside.contexts[1]!.state).not.toHaveProperty("value");
    runtime.close();
  });

  it("shows the warnings of read", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    outside.warning = "STRIPE_KEY is not set.";
    const types = defineResources(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types, { secrets: [] }));

    expect(runtime.events).toContainEqual({
      level: "warn",
      event: "reconciler.source.warning",
      resourceId: "stripe-key",
      resourceType: "test/sources/Stored",
      message: "STRIPE_KEY is not set.",
    });
    runtime.close();
  });

  it("is refused by --replace", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));

    await expect(
      createPlan({
        resources: declare(types),
        state: runtime.state,
        deploymentId: "credentials",
        nameScope: { app: "shop", stage: "prod" },
        requested: { replace: [{ id: "stripe-key" }] },
      }),
    ).rejects.toThrow("stripe-key is a source, and a source is never replaced");
    runtime.close();
  });
});

describe("a deploy that is resumed after a resource took a source's value", () => {
  it("loads the value again for the next resource, and does not update the first", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa:create:remote:effect:0",
    });
    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a", "b"] })),
    ).rejects.toThrow("simulated process crash");
    outside.calls.length = 0;

    await runtime.nextProcess("first", declare(types, { secrets: ["a", "b"] }));

    expect(outside.calls).toEqual(["load STRIPE_KEY@1", "create b=sk_1"]);
    runtime.close();
  });
});

describe("a plan with a source", () => {
  const plan = (
    resources: BaseResource[],
    runtime: ReturnType<typeof createRuntime>,
  ) =>
    createPlan({
      resources,
      state: runtime.state,
      nameScope: { app: "shop", stage: "prod" },
    });

  it("reads every source, and shows a new revision as an update of the source and of what takes it", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));
    set(outside, "STRIPE_KEY", "sk_2");
    outside.calls.length = 0;

    const { nodes } = await plan(declare(types), runtime);

    expect(outside.calls).toEqual(["read STRIPE_KEY"]);
    expect(nodes[0]).toMatchObject({
      id: "stripe-key",
      decision: "update",
      diff: { updated: { revision: "2" } },
    });
    expect(nodes[1]).toMatchObject({ id: "secret:a", decision: "update" });
    runtime.close();
  });

  it("shows no change at the same revision", async () => {
    const outside = createOutside();
    set(outside, "STRIPE_KEY", "sk_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));

    const { nodes } = await plan(
      declare(types, { secrets: ["a", "b"] }),
      runtime,
    );

    expect(nodes.map((node) => node.decision)).toEqual([
      "noop",
      "noop",
      "create",
    ]);
    runtime.close();
  });
});

describe("an update of a resource that takes several credentials", () => {
  it("receives the value of each credential whose version changed, and undefined for the others", async () => {
    const outside = createOutside();
    set(outside, "A", "a_1");
    set(outside, "B", "b_1");
    const types = defineResources(outside);
    const runtime = createRuntime();
    const declared = () => {
      const a = new types.Stored("a", { config: { key: "A" } });
      const b = new types.Stored("b", { config: { key: "B" } });
      return [
        a,
        b,
        new types.Bundle("bundle", {
          config: {
            name: "bundle",
            Values: { A: a.credentials.value, B: b.credentials.value },
          },
        }),
      ];
    };
    await runtime.deploy("first", declared());
    set(outside, "A", "a_2");
    outside.calls.length = 0;

    await runtime.nextProcess("second", declared());

    expect(outside.calls).toEqual([
      "read A",
      "read B",
      "load A@2",
      "update bundle",
    ]);
    expect(outside.updates).toEqual([
      {
        patch: { Values: { A: "a_2", B: undefined } },
        params: { name: "bundle", Values: { A: "a_2", B: undefined } },
      },
    ]);
    runtime.close();
  });

  it("receives, in a drift update, the value of each credential that the remote lost", async () => {
    const outside = createOutside();
    set(outside, "A", "a_1");
    set(outside, "B", "b_1");
    const types = defineResources(outside);
    const runtime = createRuntime({ driftDetection: true });
    const declared = () => {
      const a = new types.Stored("a", { config: { key: "A" } });
      const b = new types.Stored("b", { config: { key: "B" } });
      return [
        a,
        b,
        new types.Bundle("bundle", {
          config: {
            name: "bundle",
            Values: { A: a.credentials.value, B: b.credentials.value },
          },
        }),
      ];
    };
    await runtime.deploy("first", declared());
    outside.lost.add("B");
    outside.calls.length = 0;

    await runtime.nextProcess("second", declared());

    expect(outside.calls).toEqual([
      "read A",
      "read B",
      "load B@1",
      "update bundle",
    ]);
    expect(outside.updates).toEqual([
      {
        patch: { Values: { A: undefined, B: "b_1" } },
        params: { name: "bundle", Values: { A: undefined, B: "b_1" } },
      },
    ]);
    runtime.close();
  });
});
