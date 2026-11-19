import * as v from "valibot";
import { setTimeout as sleep } from "node:timers/promises";
import {
  credentialSourceResource,
  resource,
  ResourceOperationPendingError,
  type BaseResource,
} from "@notation/resource";
import { clearSecretValues, recordSecretValue } from "@notation/utils";
import { beforeEach, describe, expect, it } from "vitest";
import { clearHeldCredentials } from "../src/credentials";
import * as durable from "../src/durable";
import { createPlan } from "../src/planner";
import { SourcePrefetchError } from "../src/prefetch";
import { createRuntime } from "./credentials-runtime";

type Fetched = { executionId: string; values: Record<string, string> };

/** The values outside notation, and a log of every call. */
type Outside = {
  values: Map<string, string>;
  calls: string[];
  /** The `prefetched` that each `read` and `loadCredential` received. */
  received: { call: string; prefetched: unknown }[];
  /** The keys that `prefetch` puts in `failed`. */
  failing: Set<string>;
  /** Makes `prefetch` throw with this message. */
  throwing?: string;
  /** Makes `prefetch` call `notify` with this message. */
  notice?: string;
};

function createOutside(): Outside {
  return { values: new Map(), calls: [], received: [], failing: new Set() };
}

/** A class of source with a `prefetch`, which logs its calls with `name`. */
function defineFetchedSource(outside: Outside, name: string) {
  return credentialSourceResource<{
    Params: { key: string };
    Value: string;
  }>({ type: `test/prefetch/${name}`, provider: "test" })
    .defineSchema({
      key: { propertyType: "param", presence: "required", value: v.string() },
      revision: {
        propertyType: "computed",
        presence: "required",
        value: v.string(),
      },
      value: { propertyType: "credential", value: v.string() },
    } as const)
    .defineOperations({
      prefetch: async (sources, context) => {
        outside.calls.push(
          `prefetch ${name} ${sources.map((source) => `${source.id}:${source.params.key}`).join(",")}`,
        );
        if (outside.notice) context.notify(outside.notice);
        if (outside.throwing) throw new Error(outside.throwing);
        const values: Record<string, string> = {};
        const failed: { id: string; error: Error }[] = [];
        for (const { id, params } of sources) {
          if (outside.failing.has(params.key)) {
            failed.push({ id, error: new Error(`${params.key} is not set`) });
          } else {
            values[params.key] = outside.values.get(params.key)!;
          }
        }
        return {
          prefetched: { executionId: context.executionId, values },
          failed,
        };
      },
      read: async (params, context) => {
        outside.calls.push(`read ${name} ${params.key}`);
        outside.received.push({
          call: `read ${params.key}`,
          prefetched: context.prefetched,
        });
        const value =
          context.prefetched?.values[params.key] ??
          outside.values.get(params.key)!;
        return { revision: value };
      },
      loadCredential: async (state, context) => {
        outside.calls.push(`load ${name} ${state.key}`);
        outside.received.push({
          call: `load ${state.key}`,
          prefetched: context.prefetched,
        });
        return (
          context.prefetched?.values[state.key] ??
          outside.values.get(state.key)!
        );
      },
    });
}

function defineResources(outside: Outside) {
  const Secret = resource<{
    Key: { name: string };
    CreateParams: { name: string; Value: string };
    UpdateParams: { Value: string };
    ReadResult: {};
  }>({ type: "test/prefetch/Secret", provider: "test" })
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
  return {
    Alpha: defineFetchedSource(outside, "Alpha"),
    Beta: defineFetchedSource(outside, "Beta"),
    Secret,
  };
}

type Types = ReturnType<typeof defineResources>;

/**
 * A plain secret first, then two Alpha sources and one Beta source, and a
 * secret for each source that takes its value.
 */
function declare(types: Types): BaseResource[] {
  const plain = new types.Secret("plain", {
    config: { name: "plain", Value: "v" },
  });
  const sources = [
    new types.Alpha("a1", { config: { key: "A1" } }),
    new types.Alpha("a2", { config: { key: "A2" } }),
    new types.Beta("b1", { config: { key: "B1" } }),
  ];
  return [
    plain,
    ...sources,
    ...sources.map(
      (source) =>
        new types.Secret(`secret:${source.id}`, {
          config: { name: source.id, Value: source.credentials.value },
        }),
    ),
  ];
}

function setValues(outside: Outside) {
  outside.values.set("A1", "a1-value");
  outside.values.set("A2", "a2-value");
  outside.values.set("B1", "b1-value");
}

function plan(
  resources: BaseResource[],
  runtime: ReturnType<typeof createRuntime>,
  executionId?: string,
) {
  return createPlan({
    resources,
    state: runtime.state,
    app: "shop",
    stage: "prod",
    ...(executionId ? { executionId } : {}),
  });
}

beforeEach(() => {
  clearHeldCredentials();
  clearSecretValues();
});

describe("prefetch", () => {
  it("runs once for each class in deploy, before any operation of any resource", async () => {
    const outside = createOutside();
    setValues(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", declare(defineResources(outside)));

    expect(outside.calls.slice(0, 3)).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
      "create plain=v",
    ]);
    expect(
      outside.calls.filter((call) => call.startsWith("prefetch")),
    ).toHaveLength(2);
    runtime.close();
  });

  it("runs once for each class in plan, before any operation of any resource", async () => {
    const outside = createOutside();
    setValues(outside);
    const runtime = createRuntime();

    await plan(declare(defineResources(outside)), runtime);

    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
      "read Alpha A1",
      "read Alpha A2",
      "read Beta B1",
    ]);
    runtime.close();
  });

  it("gives read and loadCredential the prefetched value of their own class and deploy", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types));
    outside.values.set("A1", "a1-new");
    await runtime.nextProcess("second", declare(types));

    const alpha = (executionId: string, a1: string) => ({
      executionId,
      values: { A1: a1, A2: "a2-value" },
    });
    const beta = (executionId: string) => ({
      executionId,
      values: { B1: "b1-value" },
    });
    expect(outside.received).toEqual([
      { call: "read A1", prefetched: alpha("first", "a1-value") },
      { call: "read A2", prefetched: alpha("first", "a1-value") },
      { call: "read B1", prefetched: beta("first") },
      { call: "load A1", prefetched: alpha("first", "a1-value") },
      { call: "load A2", prefetched: alpha("first", "a1-value") },
      { call: "load B1", prefetched: beta("first") },
      { call: "read A1", prefetched: alpha("second", "a1-new") },
      { call: "read A2", prefetched: alpha("second", "a1-new") },
      { call: "read B1", prefetched: beta("second") },
      { call: "load A1", prefetched: alpha("second", "a1-new") },
    ]);
    expect(outside.calls).toContain("update a1=a1-new");
    runtime.close();
  });

  it("gives read the prefetched value of its own plan", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime();

    await plan(declare(types), runtime, "plan-1");
    await plan(declare(types), runtime, "plan-2");

    expect(
      outside.received.map(
        ({ call, prefetched }) =>
          `${call} ${(prefetched as Fetched).executionId}`,
      ),
    ).toEqual([
      "read A1 plan-1",
      "read A2 plan-1",
      "read B1 plan-1",
      "read A1 plan-2",
      "read A2 plan-2",
      "read B1 plan-2",
    ]);
    runtime.close();
  });

  it("stops deploy before the first change, with every failed source in one error", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.failing = new Set(["A2", "B1"]);
    const runtime = createRuntime();

    const error = await runtime
      .deploy("first", declare(defineResources(outside)))
      .catch((error: unknown) => error);

    expect(SourcePrefetchError.is(error)).toBe(true);
    expect((error as Error).message).toBe(
      [
        "2 sources could not be fetched.",
        "  a2 (test/prefetch/Alpha): A2 is not set",
        "  b1 (test/prefetch/Beta): B1 is not set",
      ].join("\n"),
    );
    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
    ]);
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("stops plan with every failed source in one error", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.failing = new Set(["A1"]);
    const runtime = createRuntime();

    await expect(
      plan(declare(defineResources(outside)), runtime),
    ).rejects.toThrow(
      "1 source could not be fetched.\n  a1 (test/prefetch/Alpha): A1 is not set",
    );
    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
    ]);
    runtime.close();
  });

  it("stops deploy before the first change when it throws, and calls no other class", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.throwing = "op is required";
    const runtime = createRuntime();

    await expect(
      runtime.deploy("first", declare(defineResources(outside))),
    ).rejects.toThrow("op is required");
    expect(outside.calls).toEqual(["prefetch Alpha a1:A1,a2:A2"]);
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("scrubs secret values from the errors", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.failing = new Set(["A1"]);
    const types = defineResources(outside);
    const runtime = createRuntime();
    recordSecretValue("A1 is not");

    await expect(plan(declare(types), runtime)).rejects.toThrow(
      "a1 (test/prefetch/Alpha): <hidden> set",
    );
    runtime.close();
  });

  it("is called once, by the first load, when a deploy resumes, and the resume uses only what that call fetched", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa1:create:remote:effect:0",
    });
    await expect(runtime.deploy("first", declare(types))).rejects.toThrow(
      "simulated process crash",
    );
    outside.calls.length = 0;
    // The fake `loadCredential` does not check the revision, so the value
    // that the resume creates shows which fetch it came from.
    outside.values.set("A2", "a2-new");

    await runtime.nextProcess("first", declare(types));

    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
      "load Alpha A1",
      "load Alpha A2",
      "create a2=a2-new",
      "load Beta B1",
      "create b1=b1-value",
    ]);
    runtime.close();
  });

  it("is not called when a deploy resumes, until a read or a load runs", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    // The sources first, so that the resume replays every read, and creates
    // `plain` before it loads a value.
    const declareSourcesFirst = () => {
      const [plain, ...rest] = declare(types);
      return [...rest.slice(0, 3), plain!, ...rest.slice(3)];
    };
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:b1:source-read:read",
    });
    await expect(
      runtime.deploy("first", declareSourcesFirst()),
    ).rejects.toThrow("simulated process crash");
    outside.calls.length = 0;
    outside.received.length = 0;
    outside.values.set("A1", "a1-new");

    await runtime.nextProcess("first", declareSourcesFirst());

    expect(outside.calls).toEqual([
      "create plain=v",
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
      "load Alpha A1",
      "create a1=a1-new",
      "load Alpha A2",
      "create a2=a2-value",
      "load Beta B1",
      "create b1=b1-value",
    ]);
    expect(outside.received[0]).toEqual({
      call: "load A1",
      prefetched: {
        executionId: "first",
        values: { A1: "a1-new", A2: "a2-value" },
      },
    });
    runtime.close();
  });

  it("is not called by a wake after a retry delay that replays every read", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    let attempts = 0;
    const Pending = resource({
      type: "test/prefetch/Pending",
      provider: "test",
    })
      .defineSchema({})
      .defineOperations({
        create: async () => {
          attempts += 1;
          outside.calls.push(`create pending ${attempts}`);
          if (attempts === 1) {
            throw new ResourceOperationPendingError("not ready", {
              // Longer than a SQLite write, so that the deploy suspends.
              retryAfterMs: 50,
            });
          }
        },
        delete: async () => undefined,
      });
    const declareWithPending = () => [
      new types.Alpha("a1", { config: { key: "A1" } }),
      new types.Beta("b1", { config: { key: "B1" } }),
      new Pending("pending"),
    ];
    const runtime = createRuntime();

    const suspended = await runtime.deploy("first", declareWithPending());
    expect(suspended.status).toBe("suspended");
    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1",
      "prefetch Beta b1:B1",
      "read Alpha A1",
      "read Beta B1",
      "create pending 1",
    ]);
    outside.calls.length = 0;

    await sleep(75);
    await runtime.deploy("first", declareWithPending());

    expect(outside.calls).toEqual(["create pending 2"]);
    runtime.close();
  });

  it("fails a resumed deploy when a source can no longer be fetched", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa1:create:remote:effect:0",
    });
    await expect(runtime.deploy("first", declare(types))).rejects.toThrow(
      "simulated process crash",
    );
    outside.calls.length = 0;
    outside.failing = new Set(["A1"]);

    const error = await runtime
      .nextProcess("first", declare(types))
      .catch((error: unknown) => error);

    expect(SourcePrefetchError.is(error)).toBe(true);
    expect((error as Error).message).toContain(
      "a1 (test/prefetch/Alpha): A1 is not set",
    );
    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
    ]);
    runtime.close();
  });

  it("is called before any change when a deploy resumes before it has once succeeded", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime({
      crashAfterStep: "notation:recorded-outputs",
    });
    await expect(runtime.deploy("first", declare(types))).rejects.toThrow(
      "simulated process crash",
    );
    expect(outside.calls).toEqual([]);
    outside.failing = new Set(["B1"]);

    const error = await runtime
      .nextProcess("first", declare(types))
      .catch((error: unknown) => error);

    expect(SourcePrefetchError.is(error)).toBe(true);
    expect((error as SourcePrefetchError).failed).toEqual([
      { id: "b1", type: "test/prefetch/Beta", message: "B1 is not set" },
    ]);
    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
    ]);
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("fails a resumed deploy with the journaled error, and no new call, when it failed before the crash", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.failing = new Set(["A1"]);
    const types = defineResources(outside);
    const runtime = createRuntime({ crashAfterStep: "notation:prefetch" });
    await expect(runtime.deploy("first", declare(types))).rejects.toThrow(
      "simulated process crash",
    );
    outside.calls.length = 0;
    outside.failing = new Set();

    const error = await runtime
      .nextProcess("first", declare(types))
      .catch((error: unknown) => error);

    expect(SourcePrefetchError.is(error)).toBe(true);
    expect((error as Error).message).toContain(
      "a1 (test/prefetch/Alpha): A1 is not set",
    );
    expect(outside.calls).toEqual([]);
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("is not called by a read or load of a source whose class has no prefetch, when a deploy resumes", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const Plain = credentialSourceResource<{
      Params: { key: string };
      Value: string;
    }>({ type: "test/prefetch/Plain", provider: "test" })
      .defineSchema({
        key: { propertyType: "param", presence: "required", value: v.string() },
        revision: {
          propertyType: "computed",
          presence: "required",
          value: v.string(),
        },
        value: { propertyType: "credential", value: v.string() },
      } as const)
      .defineOperations({
        read: async (params, context) => {
          outside.calls.push(`read Plain ${params.key}`);
          outside.received.push({
            call: `read ${params.key}`,
            prefetched: context.prefetched,
          });
          return { revision: outside.values.get(params.key)! };
        },
        loadCredential: async (state, context) => {
          outside.calls.push(`load Plain ${state.key}`);
          outside.received.push({
            call: `load ${state.key}`,
            prefetched: context.prefetched,
          });
          return outside.values.get(state.key)!;
        },
      });
    outside.values.set("P1", "p1-value");
    const declareWithPlain = () => {
      const alpha = new types.Alpha("a1", { config: { key: "A1" } });
      const plain = new Plain("p1", { config: { key: "P1" } });
      return [
        alpha,
        new types.Secret("first", { config: { name: "first", Value: "v" } }),
        plain,
        new types.Secret("secret:p1", {
          config: { name: "p1", Value: plain.credentials.value },
        }),
        new types.Secret("secret:a1", {
          config: { name: "a1", Value: alpha.credentials.value },
        }),
      ];
    };
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:first:create:remote:effect:0",
    });
    await expect(runtime.deploy("first", declareWithPlain())).rejects.toThrow(
      "simulated process crash",
    );
    outside.calls.length = 0;
    outside.received.length = 0;

    await runtime.nextProcess("first", declareWithPlain());

    expect(outside.calls).toEqual([
      "read Plain P1",
      "load Plain P1",
      "create p1=p1-value",
      "prefetch Alpha a1:A1",
      "load Alpha A1",
      "create a1=a1-value",
    ]);
    expect(outside.received.slice(0, 2)).toEqual([
      { call: "read P1", prefetched: undefined },
      { call: "load P1", prefetched: undefined },
    ]);
    runtime.close();
  });

  it("leaves out a source whose params hold an output, which read fetches", async () => {
    const outside = createOutside();
    outside.values.set("A1", "a1-value");
    outside.values.set("named", "named-value");
    const types = defineResources(outside);
    const declareWithRef = () => {
      const name = new types.Secret("name", {
        config: { name: "named", Value: "v" },
      });
      const known = new types.Alpha("a1", { config: { key: "A1" } });
      const fromOutput = new types.Alpha("a-ref", {
        config: { key: name.outputRef("name") } as any,
      });
      return [name, known, fromOutput];
    };
    const runtime = createRuntime();

    await plan(declareWithRef(), runtime);
    await runtime.deploy("first", declareWithRef());

    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1",
      "read Alpha A1",
      "prefetch Alpha a1:A1",
      "create named=v",
      "read Alpha A1",
      "read Alpha named",
    ]);
    expect(outside.received.at(-1)).toEqual({
      call: "read named",
      prefetched: undefined,
    });

    // The output is in state now, and the source is still left out.
    outside.calls.length = 0;
    await plan(declareWithRef(), runtime);
    expect(outside.calls[0]).toBe("prefetch Alpha a1:A1");
    runtime.close();
  });

  it("leaves out a source that depends on a resource, even with known params", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const declareWithDependency = () => {
      const plain = new types.Secret("plain", {
        config: { name: "plain", Value: "v" },
      });
      const independent = new types.Alpha("a1", { config: { key: "A1" } });
      const dependent = new types.Alpha("a2", { config: { key: "A2" } });
      dependent.dependOn(plain);
      return [plain, independent, dependent];
    };
    const runtime = createRuntime();

    await plan(declareWithDependency(), runtime);
    await runtime.deploy("first", declareWithDependency());

    expect(outside.calls).toEqual([
      "prefetch Alpha a1:A1",
      "read Alpha A1",
      "read Alpha A2",
      "prefetch Alpha a1:A1",
      "create plain=v",
      "read Alpha A1",
      "read Alpha A2",
    ]);
    runtime.close();
  });

  it("is not called by a deploy that fails on validation or on an override", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const Guarded = resource<{
      Key: { name: string };
      CreateParams: { name: string; keep: boolean };
      UpdateParams: { keep: boolean };
      ReadResult: {};
    }>({ type: "test/prefetch/Guarded", provider: "test" })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          primaryKey: true,
          immutable: true,
          value: v.string(),
        },
        keep: {
          propertyType: "param",
          presence: "required",
          value: v.boolean(),
        },
      } as const)
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        rejectChange: (previous, desired) =>
          previous.keep && desired?.keep !== true ? "it is kept" : undefined,
      });
    const runtime = createRuntime();
    await runtime.deploy("first", [
      new Guarded("guarded", { config: { name: "g", keep: true } }),
    ]);

    await expect(
      runtime.deploy("rejected", [
        ...declare(types),
        new Guarded("guarded", { config: { name: "g", keep: false } }),
      ]),
    ).rejects.toThrow("it is kept");
    await expect(
      runtime.deploy("override", declare(types), {
        replace: [{ id: "missing" }],
      }),
    ).rejects.toThrow("missing");

    expect(outside.calls).toEqual([]);
    runtime.close();
  });

  it("is not called by a deploy that waits for the deployment hold, until it holds it", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime();
    const hold = runtime.stores.store(
      durable.deploymentHoldStore,
      runtime.state.deploymentId,
    );
    await hold.update(() => ({ holder: "other-execution" }));

    const waiting = await runtime.deploy("waiter", declare(types));

    expect(waiting.status).toBe("suspended");
    expect(outside.calls).toEqual([]);

    await durable.clearDeploymentHold({
      storeClient: runtime.stores,
      deploymentId: runtime.state.deploymentId,
      fromExecutionId: "other-execution",
    });
    await runtime.deploy("waiter", declare(types));

    expect(outside.calls.slice(0, 2)).toEqual([
      "prefetch Alpha a1:A1,a2:A2",
      "prefetch Beta b1:B1",
    ]);
    runtime.close();
  });

  it("is not called by destroy", async () => {
    const outside = createOutside();
    setValues(outside);
    const types = defineResources(outside);
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types));
    outside.calls.length = 0;

    await runtime.destroy("destroy", declare(types));

    expect(outside.calls.some((call) => call.startsWith("prefetch"))).toBe(
      false,
    );
    expect(await runtime.state.values()).toEqual([]);
    runtime.close();
  });

  it("is not called for a class with no source", async () => {
    const outside = createOutside();
    const types = defineResources(outside);
    const runtime = createRuntime();

    await runtime.deploy("first", [
      new types.Secret("plain", { config: { name: "plain", Value: "v" } }),
    ]);

    expect(outside.calls).toEqual(["create plain=v"]);
    runtime.close();
  });

  it("shows each message that it passes to notify as an event", async () => {
    const outside = createOutside();
    setValues(outside);
    outside.notice = "Waiting for the vault.";
    const runtime = createRuntime();

    await runtime.deploy("first", declare(defineResources(outside)));

    expect(
      runtime.events.filter(
        (event) => event.event === "reconciler.source.notice",
      ),
    ).toEqual([
      {
        level: "info",
        event: "reconciler.source.notice",
        resourceType: "test/prefetch/Alpha",
        message: "Waiting for the vault.",
      },
      {
        level: "info",
        event: "reconciler.source.notice",
        resourceType: "test/prefetch/Beta",
        message: "Waiting for the vault.",
      },
    ]);
    runtime.close();
  });
});
