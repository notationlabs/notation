import { describe, expect, it } from "vitest";
import {
  ContributionConflictError,
  UNKNOWN_AFTER_APPLY,
  collectResourceGraph,
  diffParams,
  mergeContributions,
  onEvaluationEnd,
  resource,
} from "src";

type Statement = { Effect: string; Action: string[]; Resource: string };
type PolicyDocument = { Version: string; Statement: Statement[] };

const Queue = resource<{
  Key: { QueueUrl: string };
  CreateParams: { QueueName: string };
  UpdateParams: {};
  ReadResult: { QueueArn: string; QueueUrl: string };
}>({ type: "test/contributions/queue" })
  .defineSchema({
    QueueUrl: {
      propertyType: "computed",
      presence: "required",
      primaryKey: true,
    },
    QueueName: { propertyType: "param", presence: "required", immutable: true },
    QueueArn: { propertyType: "computed", presence: "required" },
  })
  .defineOperations({
    create: async () => ({ QueueUrl: "url" }),
    delete: async () => undefined,
  });

const Policy = resource<{
  Key: { PolicyName: string };
  CreateParams: { PolicyName: string; PolicyDocument: PolicyDocument };
  UpdateParams: { PolicyDocument: PolicyDocument };
  ReadResult: {};
}>({ type: "test/contributions/policy" })
  .defineSchema({
    PolicyName: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    PolicyDocument: {
      propertyType: "param",
      presence: "required",
      collect: (items) => ({
        Version: "2012-10-17",
        Statement: items.flatMap(
          (item) => (item.Statement ?? []) as Statement[],
        ),
      }),
    },
  })
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  });

type Environment = { Variables: Record<string, string> };

const Fn = resource<{
  Key: { FunctionName: string };
  CreateParams: {
    FunctionName: string;
    Environment?: Environment;
    Role: string;
  };
  UpdateParams: { Environment?: Environment; Role: string };
  ReadResult: { FunctionArn: string };
}>({ type: "test/contributions/function" })
  .defineSchema({
    FunctionName: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    Environment: {
      propertyType: "param",
      presence: "optional",
      collect: mergeContributions,
    },
    Role: { propertyType: "param", presence: "required" },
    FunctionArn: { propertyType: "computed", presence: "required" },
  })
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  });

const grant = (arn: string): Statement => ({
  Effect: "Allow",
  Action: ["sqs:ReceiveMessage"],
  Resource: arn,
});

describe("collected params", () => {
  it("combines config and contributions with the schema's rule", async () => {
    const policy = new Policy("policy", {
      config: {
        PolicyName: "p",
        PolicyDocument: { Version: "2012-10-17", Statement: [grant("own")] },
      },
    });
    policy.contribute({ PolicyDocument: { Statement: [grant("b")] } });
    policy.contribute({ PolicyDocument: { Statement: [grant("a")] } });

    expect((await policy.getParams()).PolicyDocument).toEqual({
      Version: "2012-10-17",
      Statement: [grant("own"), grant("a"), grant("b")],
    });
  });

  it("gives the same result whatever order contributions arrive in", async () => {
    const build = async (order: string[]) => {
      const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
      for (const name of order) {
        fn.contribute({ Environment: { Variables: { [name]: name } } });
      }
      return JSON.stringify((await fn.getParams()).Environment);
    };
    expect(await build(["A", "B", "C"])).toBe(await build(["C", "A", "B"]));
  });

  it("leaves a collected param unset when nothing contributes to it", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    expect((await fn.getParams()).Environment).toBeUndefined();
  });

  it("does not require a collected param in config", () => {
    new Policy("policy", { config: { PolicyName: "p" } });
  });

  it("accepts only collected params", () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    // @ts-expect-error Role is not collected
    expect(() => fn.contribute({ Role: "other" })).toThrow(
      "Cannot contribute Role to fn: test/contributions/function does not collect it",
    );
  });

  it("fails on two values for one key, naming both contributors", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(
      { Environment: { Variables: { MODE: "a" } } },
      { by: "orders-mapping" },
    );
    fn.contribute({ Environment: { Variables: { MODE: "b" } } });

    const error = await fn.getParams().catch((caught) => caught);
    expect(error).toBeInstanceOf(ContributionConflictError);
    expect(error.message).toMatch(
      /^Conflicting contributions to fn: orders-mapping and packages\/resource\/test\/contributions\.test\.ts:\d+ both set Environment\.Variables\.MODE, to "a" and "b"$/,
    );
  });

  it("accepts the same value from two contributors", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute({ Environment: { Variables: { MODE: "a" } } });
    fn.contribute({ Environment: { Variables: { MODE: "a", X: "x" } } });
    expect((await fn.getParams()).Environment).toEqual({
      Variables: { MODE: "a", X: "x" },
    });
  });

  it("updates the resource when a contributor is removed", () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    const previous = {
      FunctionName: "f",
      Role: "r",
      Environment: { Variables: { A: "a", B: "b" } },
    };
    const desired = {
      FunctionName: "f",
      Role: "r",
      Environment: { Variables: { A: "a" } },
    };
    const result = diffParams(fn.schema, previous, desired, {
      canUpdate: true,
    });
    expect(result.patch).toEqual({ Environment: { Variables: { A: "a" } } });
    expect(result.replaceFields).toEqual([]);

    const { FunctionName, Role } = desired;
    const removed = diffParams(
      fn.schema,
      previous,
      { FunctionName, Role },
      {
        canUpdate: true,
      },
    );
    expect(removed.patch).toEqual({ Environment: undefined });
  });
});

describe("contribution lifetime", () => {
  it("closes contributions when evaluation ends", async () => {
    let fn!: InstanceType<typeof Fn>;
    await collectResourceGraph(() => {
      fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
      fn.contribute({ Environment: { Variables: { A: "a" } } });
    });
    expect(() =>
      fn.contribute({ Environment: { Variables: { B: "b" } } }),
    ).toThrow("Cannot contribute to fn: evaluation has ended");
    expect(() =>
      fn.dependOn(new Queue("q", { config: { QueueName: "q" } })),
    ).toThrow("Cannot add a dependency to fn: evaluation has ended");
  });

  it("runs end-of-evaluation callbacks before the close", async () => {
    let fn!: InstanceType<typeof Fn>;
    await collectResourceGraph(() => {
      fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
      onEvaluationEnd(() => {
        fn.contribute({ Environment: { Variables: { LATE: "1" } } });
        onEvaluationEnd(() =>
          fn.contribute({ Environment: { Variables: { LATER: "2" } } }),
        );
      });
    });
    expect((await fn.getParams()).Environment).toEqual({
      Variables: { LATE: "1", LATER: "2" },
    });
  });

  it("rejects end-of-evaluation callbacks outside evaluation", () => {
    expect(() => onEvaluationEnd(() => undefined)).toThrow();
  });

  it("closes contributions once the params have been read", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    await fn.getParams();
    expect(() =>
      fn.contribute({ Environment: { Variables: { A: "a" } } }),
    ).toThrow("its params have already been read");
  });
});

describe("output values", () => {
  it("places an output value in config and in a template string", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.contribute({
      PolicyDocument: {
        Statement: [
          grant(queue.outputValue("QueueArn")),
          grant(`${queue.outputValue("QueueArn")}/*`),
        ],
      },
    });

    expect(policy.getDependencies()).toEqual([queue]);
    await expect(policy.getParams()).rejects.toThrow(
      "was read before orders was deployed",
    );

    queue.setOutput({
      QueueUrl: "url",
      QueueName: "orders",
      QueueArn: "arn:q",
    });
    expect((await policy.getParams()).PolicyDocument.Statement).toEqual([
      grant("arn:q"),
      grant("arn:q/*"),
    ]);
  });

  it("keeps an output value that is not a string whole", async () => {
    const Counter = resource({ type: "test/contributions/counter" })
      .defineSchema({
        size: { propertyType: "param", presence: "required" },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const source = new Counter("source");
    const holder = new Counter("holder", {
      config: { size: source.outputValue("size") } as any,
    });
    source.setOutput({ size: 3 });
    expect(await holder.getParams()).toEqual({ size: 3 });
  });

  it("gives tokens for nested paths", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", {
      config: {
        FunctionName: "f",
        Role: (queue.outputValue("QueueUrl") as any).nested.path,
      },
    });
    queue.setOutput({ QueueUrl: { nested: { path: "deep" } } } as any);
    expect((await fn.getParams()).Role).toBe("deep");
  });

  it("rejects an output value as a map key", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    expect(() =>
      fn.contribute({
        Environment: { Variables: { [queue.outputValue("QueueArn")]: "x" } },
      }),
    ).toThrow("is used as a map key");
  });

  it("adds dependencies after construction with dependOn", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.dependOn(queue);
    expect(fn.getDependencies()).toEqual([queue]);
  });
});

describe("plan params", () => {
  const LogGroup = resource<{
    Key: { logGroupName: string };
    CreateParams: { logGroupName: string; retention?: number };
    UpdateParams: { retention?: number };
    ReadResult: {};
  }>({ type: "test/contributions/log-group" })
    .defineSchema({
      logGroupName: {
        propertyType: "param",
        presence: "required",
        primaryKey: true,
        immutable: true,
      },
      retention: { propertyType: "param", presence: "optional" },
    })
    .defineOperations({
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => undefined,
    });

  const fnWith = () =>
    new Fn("fn", { config: { FunctionName: "f", Role: "r" } });

  it("marks a value unknown at its own path", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = fnWith();
    fn.contribute({ Environment: { Variables: { KNOWN: "k" } } });
    fn.contribute({
      Environment: { Variables: { QUEUE: `${queue.outputValue("QueueArn")}` } },
    });

    expect(await fn.planParams()).toEqual({
      FunctionName: "f",
      Role: "r",
      Environment: { Variables: { KNOWN: "k", QUEUE: UNKNOWN_AFTER_APPLY } },
    });
  });

  it("fills in outputs that a dependency already has", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    queue.setOutput({
      QueueUrl: "url",
      QueueName: "orders",
      QueueArn: "arn:q",
    });
    const fn = fnWith();
    fn.contribute({
      Environment: { Variables: { QUEUE: queue.outputValue("QueueArn") } },
    });
    expect((await fn.planParams()).Environment).toEqual({
      Variables: { QUEUE: "arn:q" },
    });
  });

  it("does not find a conflict between values not known yet", async () => {
    const a = new Queue("a", { config: { QueueName: "a" } });
    const b = new Queue("b", { config: { QueueName: "b" } });
    const fn = fnWith();
    fn.contribute({
      Environment: { Variables: { Q: a.outputValue("QueueArn") } },
    });
    fn.contribute({
      Environment: { Variables: { Q: b.outputValue("QueueArn") } },
    });
    expect((await fn.planParams()).Environment).toEqual({
      Variables: { Q: UNKNOWN_AFTER_APPLY },
    });
  });

  it("gives deriveParams tokens for a dependency's output", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionName}`,
    }));
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn: fnWith() },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: 7,
    });
  });

  it("knows every param when an ordering-only dependency is not read", async () => {
    const Ordered = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(() => ({ logGroupName: "fixed" }));
    const logGroup = new Ordered("logs", { dependencies: { fn: fnWith() } });
    expect(await logGroup.planParams()).toEqual({ logGroupName: "fixed" });
  });

  it("falls back to the cautious answer when a token is taken apart", async () => {
    const Mangled = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: deps.fn.output.FunctionArn.split(":")[1]!,
    }));
    const logGroup = new Mangled("logs", {
      config: { retention: 7 },
      dependencies: { fn: fnWith() },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: 7,
    });
  });

  it("falls back to the cautious answer when no token reaches a param", async () => {
    const Dropped = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: deps.fn.output.FunctionArn ? "a" : "b",
    }));
    const logGroup = new Dropped("logs", { dependencies: { fn: fnWith() } });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: UNKNOWN_AFTER_APPLY,
    });
  });

  it("falls back to the cautious answer when a token is computed with as a string", async () => {
    const Computed = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionName}`,
      retention: `${deps.fn.output.FunctionArn}`.split(":").length,
    }));
    const logGroup = new Computed("logs", { dependencies: { fn: fnWith() } });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: UNKNOWN_AFTER_APPLY,
    });
  });

  it("falls back to the cautious answer when deriveParams throws", async () => {
    const Throws = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => {
      if (!deps.fn.output.FunctionArn.startsWith("arn:")) throw new Error("no");
      return { logGroupName: "x" };
    });
    const logGroup = new Throws("logs", {
      config: { retention: 1 },
      dependencies: { fn: fnWith() },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: 1,
    });
  });

  it("runs deriveParams unchanged at deploy", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionName}`,
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r", FunctionArn: "arn" });
    const logGroup = new Derived("logs", { dependencies: { fn } });
    expect(await logGroup.getParams()).toEqual({
      logGroupName: "/aws/lambda/f",
    });
  });
});
