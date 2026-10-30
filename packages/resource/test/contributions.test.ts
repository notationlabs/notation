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
  it("places an output value whole in config and in a contribution", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.contribute({
      PolicyDocument: { Statement: [grant(queue.outputValue("QueueArn"))] },
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

  it("throws when an output value is turned into a string", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const arn = queue.outputValue("QueueArn");
    const message =
      "an output value can't be turned into a string; place it whole, or compute with it in a function that receives deps";
    expect(() => `${arn}/*`).toThrow(message);
    expect(() => String(arn)).toThrow(message);
    expect(() => arn + "").toThrow(message);
    expect(() => JSON.stringify({ arn })).toThrow(message);
    expect(() => `${arn}`).toThrow("Output orders.QueueArn: an output value");
  });

  it("throws when an output value is a map key", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    expect(() =>
      fn.contribute({
        Environment: { Variables: { [queue.outputValue("QueueArn")]: "x" } },
      }),
    ).toThrow("can't be turned into a string");
  });

  it("names output values in conflict messages", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(
      { Environment: { Variables: { Q: queue.outputValue("QueueArn") } } },
      { by: "a" },
    );
    fn.contribute({ Environment: { Variables: { Q: "other" } } }, { by: "b" });
    queue.setOutput({ QueueUrl: "url", QueueName: "orders", QueueArn: "arn" });
    await expect(fn.getParams()).rejects.toThrow(
      'a and b both set Environment.Variables.Q, to "arn" and "other"',
    );
  });

  it("sorts contributions holding output values the same whatever order tokens were made in", async () => {
    const build = async (order: string[]) => {
      const queues = Object.fromEntries(
        order.map((name) => [
          name,
          new Queue(name, { config: { QueueName: name } }),
        ]),
      );
      const policy = new Policy("policy", { config: { PolicyName: "p" } });
      for (const name of ["b", "a"]) {
        policy.contribute({
          PolicyDocument: {
            Statement: [grant(queues[name]!.outputValue("QueueArn"))],
          },
        });
      }
      for (const name of order) {
        queues[name]!.setOutput({
          QueueUrl: name,
          QueueName: name,
          QueueArn: `arn:${name}`,
        });
      }
      return (await policy.getParams()).PolicyDocument.Statement;
    };
    expect(await build(["a", "b"])).toEqual([grant("arn:a"), grant("arn:b")]);
    expect(await build(["b", "a"])).toEqual([grant("arn:a"), grant("arn:b")]);
  });

  it("adds dependencies after construction with dependOn", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.dependOn(queue);
    expect(fn.getDependencies()).toEqual([queue]);
  });
});

describe("function contributions", () => {
  const deployed = (name: string) => {
    const queue = new Queue(name, { config: { QueueName: name } });
    queue.setOutput({ QueueUrl: name, QueueName: name, QueueArn: `arn:${name}` });
    return queue;
  };

  const contributeRead = (
    policy: InstanceType<typeof Policy>,
    queue: InstanceType<typeof Queue>,
  ) =>
    policy.contribute(
      ({ deps }) => ({
        PolicyDocument: {
          Statement: [grant(`${deps.queue.output.QueueArn}/*`)],
        },
      }),
      { by: "reader", deps: { queue } },
    );

  it("runs with real outputs at deploy", async () => {
    const queue = deployed("orders");
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    contributeRead(policy, queue);
    policy.contribute({ PolicyDocument: { Statement: [grant("plain")] } });
    expect((await policy.getParams()).PolicyDocument.Statement).toEqual([
      grant("arn:orders/*"),
      grant("plain"),
    ]);
  });

  it("makes the declared deps dependencies of the receiving resource", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    contributeRead(policy, queue);
    expect(policy.getDependencies()).toEqual([queue]);
  });

  it("plans the collected param unknown when a dep has no output", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    contributeRead(policy, queue);
    policy.contribute({ PolicyDocument: { Statement: [grant("plain")] } });
    expect(await policy.planParams()).toEqual({
      PolicyName: "p",
      PolicyDocument: UNKNOWN_AFTER_APPLY,
    });
  });

  it("plans exactly when its deps have outputs", async () => {
    const pending = new Queue("pending", { config: { QueueName: "pending" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.dependOn(pending);
    contributeRead(policy, deployed("orders"));
    expect(await policy.planParams()).toEqual({
      PolicyName: "p",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [grant("arn:orders/*")],
      },
    });
  });

  it("plans the collected param unknown when the function catches the pending read", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.contribute(
      ({ deps }) => {
        let arn = "guess";
        try {
          arn = deps.queue.output.QueueArn;
        } catch {}
        return { PolicyDocument: { Statement: [grant(arn)] } };
      },
      { deps: { queue } },
    );
    expect((await policy.planParams()).PolicyDocument).toEqual(
      UNKNOWN_AFTER_APPLY,
    );
  });

  it("finds conflicts in function results", async () => {
    const queue = deployed("orders");
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(
      ({ deps }) => ({
        Environment: { Variables: { Q: deps.queue.output.QueueArn } },
      }),
      { by: "first", deps: { queue } },
    );
    fn.contribute({ Environment: { Variables: { Q: "other" } } }, { by: "second" });
    await expect(fn.getParams()).rejects.toThrow(ContributionConflictError);
    await expect(fn.planParams()).rejects.toThrow(ContributionConflictError);
  });

  it("rejects a result that sets a param that is not collected", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(() => ({ Role: "other" }) as any, { deps: {} });
    await expect(fn.getParams()).rejects.toThrow(
      "Cannot contribute Role to fn: test/contributions/function does not collect it",
    );
  });

  it("records the call site and closes with the other contributions", async () => {
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(() => ({ Environment: { Variables: { MODE: "a" } } }), {
      deps: {},
    });
    fn.contribute({ Environment: { Variables: { MODE: "b" } } }, { by: "b" });
    const error = await fn.getParams().catch((caught) => caught);
    expect(error.message).toMatch(
      /packages\/resource\/test\/contributions\.test\.ts:\d+ and b both set|b and packages\/resource\/test\/contributions\.test\.ts:\d+ both set/,
    );
    expect(() =>
      fn.contribute(() => ({}), { deps: {} }),
    ).toThrow("its params have already been read");
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
      Environment: { Variables: { QUEUE: queue.outputValue("QueueArn") } },
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

  it("plans cautiously when deriveParams reads a pending output", async () => {
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

  it("plans cautiously when deriveParams catches the pending read", async () => {
    const Caught = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => {
      let name = "guess";
      try {
        name = deps.fn.output.FunctionName;
      } catch {}
      return { logGroupName: name };
    });
    const logGroup = new Caught("logs", { dependencies: { fn: fnWith() } });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: UNKNOWN_AFTER_APPLY,
    });
  });

  it("plans exactly when deriveParams reads no pending output", async () => {
    const Ordered = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({ logGroupName: `logs-${deps.fn.id}` }));
    const logGroup = new Ordered("logs", { dependencies: { fn: fnWith() } });
    expect(await logGroup.planParams()).toEqual({ logGroupName: "logs-fn" });
  });

  it("reads outputs from state in deriveParams at plan", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
      other: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionName}`,
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r", FunctionArn: "arn" });
    const logGroup = new Derived("logs", {
      dependencies: { fn, other: fnWith() },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: "/aws/lambda/f",
    });
  });

  it("falls back to the cautious answer when deriveParams throws", async () => {
    const Throws = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(() => {
      throw new Error("no");
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
