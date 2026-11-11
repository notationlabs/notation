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
import { number, object, string } from "./validators";

type Statement = { Effect: string; Action: string[]; Resource: string };
type PolicyDocument = { Version: string; Statement: Statement[] };

const Queue = resource<{
  Key: { QueueUrl: string };
  CreateParams: { QueueName: string };
  UpdateParams: {};
  ReadResult: { QueueArn: string; QueueUrl: string };
}>({ type: "test/contributions/queue", provider: "test" })
  .defineSchema({
    QueueUrl: {
      propertyType: "computed",
      value: string(),
      presence: "required",
      primaryKey: true,
    },
    QueueName: {
      propertyType: "param",
      presence: "required",
      value: string(),
      immutable: true,
    },
    QueueArn: {
      propertyType: "computed",
      presence: "required",
      value: string(),
    },
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
}>({ type: "test/contributions/policy", provider: "test" })
  .defineSchema({
    PolicyName: {
      propertyType: "param",
      value: string(),
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    PolicyDocument: {
      propertyType: "param",
      value: object<PolicyDocument>(),
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
}>({ type: "test/contributions/function", provider: "test" })
  .defineSchema({
    FunctionName: {
      propertyType: "param",
      value: string(),
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    Environment: {
      propertyType: "param",
      value: object<Environment>(),
      presence: "optional",
      collect: mergeContributions,
    },
    Role: { propertyType: "param", presence: "required", value: string() },
    FunctionArn: {
      propertyType: "computed",
      presence: "required",
      value: string(),
    },
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
    fn.contribute({ Environment: { Variables: { MODE: "a" } } });
    fn.contribute({ Environment: { Variables: { MODE: "b" } } });

    const error = await fn.getParams().catch((caught) => caught);
    expect(error).toBeInstanceOf(ContributionConflictError);
    expect(error.message).toMatch(
      /^Conflicting contributions to fn: packages\/resource\/test\/contributions\.test\.ts:\d+ and packages\/resource\/test\/contributions\.test\.ts:\d+ both set Environment\.Variables\.MODE, to "a" and "b"$/,
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

describe("output refs", () => {
  it("places an output ref whole in config and in a contribution", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.contribute({
      PolicyDocument: { Statement: [grant(queue.outputRef("QueueArn"))] },
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

  it("keeps an output ref that is not a string whole", async () => {
    const Counter = resource({
      type: "test/contributions/counter",
      provider: "test",
    })
      .defineSchema({
        size: { propertyType: "param", presence: "required", value: number() },
      } as any)
      .defineOperations({
        create: async () => undefined,
        delete: async () => undefined,
      });
    const source = new Counter("source");
    const holder = new Counter("holder", {
      config: { size: source.outputRef("size") } as any,
    });
    source.setOutput({ size: 3 });
    expect(await holder.getParams()).toEqual({ size: 3 });
  });

  it("throws when an output ref is turned into a string", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const arn = queue.outputRef("QueueArn");
    const message =
      "an output ref can't be turned into a string; place it whole, or compute with it in a function that receives deps";
    expect(() => `${arn}/*`).toThrow(message);
    expect(() => String(arn)).toThrow(message);
    expect(() => arn + "").toThrow(message);
    expect(() => JSON.stringify({ arn })).toThrow(message);
    expect(() => `${arn}`).toThrow("Output orders.QueueArn: an output ref");
  });

  it("throws when an output ref is a map key", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    expect(() =>
      fn.contribute({
        Environment: { Variables: { [queue.outputRef("QueueArn")]: "x" } },
      }),
    ).toThrow("can't be turned into a string");
  });

  it("names output refs in conflict messages", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute({
      Environment: { Variables: { Q: queue.outputRef("QueueArn") } },
    });
    fn.contribute({ Environment: { Variables: { Q: "other" } } });
    queue.setOutput({ QueueUrl: "url", QueueName: "orders", QueueArn: "arn" });
    await expect(fn.getParams()).rejects.toThrow(
      'both set Environment.Variables.Q, to "arn" and "other"',
    );
  });

  it("sorts contributions holding output refs the same whatever order tokens were made in", async () => {
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
            Statement: [grant(queues[name]!.outputRef("QueueArn"))],
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
    queue.setOutput({
      QueueUrl: name,
      QueueName: name,
      QueueArn: `arn:${name}`,
    });
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
      { deps: { queue } },
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

  it("plans the collected param unknown when a dep's state lacks a required output", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    queue.setOutput({ QueueUrl: "orders", QueueName: "orders" } as any);
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    contributeRead(policy, queue);
    expect(await policy.planParams()).toEqual({
      PolicyName: "p",
      PolicyDocument: UNKNOWN_AFTER_APPLY,
    });
  });

  it("fails plan when the function throws without a pending read", async () => {
    const pending = new Queue("pending", { config: { QueueName: "pending" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    policy.dependOn(pending);
    policy.contribute(
      () => {
        throw new Error("no");
      },
      { deps: {} },
    );
    await expect(policy.planParams()).rejects.toThrow("no");
  });

  it("finds conflicts in function results", async () => {
    const queue = deployed("orders");
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "r" } });
    fn.contribute(
      ({ deps }) => ({
        Environment: { Variables: { Q: deps.queue.output.QueueArn } },
      }),
      { deps: { queue } },
    );
    fn.contribute({ Environment: { Variables: { Q: "other" } } });
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
    fn.contribute({ Environment: { Variables: { MODE: "b" } } });
    const error = await fn.getParams().catch((caught) => caught);
    expect(error.message).toMatch(
      /^Conflicting contributions to fn: packages\/resource\/test\/contributions\.test\.ts:\d+ and packages\/resource\/test\/contributions\.test\.ts:\d+ both set/,
    );
    expect(() => fn.contribute(() => ({}), { deps: {} })).toThrow(
      "its params have already been read",
    );
  });
});

describe("plan params", () => {
  const LogGroup = resource<{
    Key: { logGroupName: string };
    CreateParams: { logGroupName: string; retention?: number };
    UpdateParams: { retention?: number };
    ReadResult: {};
  }>({ type: "test/contributions/log-group", provider: "test" })
    .defineSchema({
      logGroupName: {
        propertyType: "param",
        value: string(),
        presence: "required",
        primaryKey: true,
        immutable: true,
      },
      retention: {
        propertyType: "param",
        presence: "optional",
        value: number(),
      },
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
      Environment: { Variables: { QUEUE: queue.outputRef("QueueArn") } },
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
      Environment: { Variables: { QUEUE: queue.outputRef("QueueArn") } },
    });
    expect((await fn.planParams()).Environment).toEqual({
      Variables: { QUEUE: "arn:q" },
    });
  });

  it("plans a required output that is missing from state as unknown", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    queue.setOutput({ QueueUrl: "url", QueueName: "orders" } as any);
    const fn = fnWith();
    fn.contribute({
      Environment: {
        Variables: {
          ARN: queue.outputRef("QueueArn"),
          URL: queue.outputRef("QueueUrl"),
        },
      },
    });
    expect((await fn.planParams()).Environment).toEqual({
      Variables: { ARN: UNKNOWN_AFTER_APPLY, URL: "url" },
    });
  });

  it("does not find a conflict between values not known yet", async () => {
    const a = new Queue("a", { config: { QueueName: "a" } });
    const b = new Queue("b", { config: { QueueName: "b" } });
    const fn = fnWith();
    fn.contribute({
      Environment: { Variables: { Q: a.outputRef("QueueArn") } },
    });
    fn.contribute({
      Environment: { Variables: { Q: b.outputRef("QueueArn") } },
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

  it("plans cautiously when deriveParams reads a required output missing from state", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionArn}`,
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: 7,
    });
  });

  it("plans exactly when deriveParams lists the keys of an output that lacks a required output, as deploy fills it in", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/${Object.keys(deps.fn.output).sort().join()}`,
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: "/FunctionArn,FunctionName,Role",
      retention: 7,
    });
  });

  it("plans cautiously when deriveParams copies an output that lacks a required output", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => {
      const output = { ...deps.fn.output };
      return { logGroupName: `/aws/lambda/${output.FunctionName}` };
    });
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: UNKNOWN_AFTER_APPLY,
      retention: 7,
    });
  });

  it("plans exactly when deriveParams tests for a required output missing from state, as deploy fills it in", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName:
        "FunctionArn" in deps.fn.output &&
        Object.hasOwn(deps.fn.output, "FunctionArn")
          ? "/arn"
          : "/none",
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: "/arn",
      retention: 7,
    });
  });

  it("plans exactly when deriveParams tests for outputs that are in state", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName:
        "FunctionName" in deps.fn.output &&
        Object.hasOwn(deps.fn.output, "Role")
          ? "/present"
          : "/absent",
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", {
      config: { retention: 7 },
      dependencies: { fn },
    });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: "/present",
      retention: 7,
    });
  });

  it("plans exactly when deriveParams reads only outputs that are in state", async () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: `/aws/lambda/${deps.fn.output.FunctionName}`,
    }));
    const fn = fnWith();
    fn.setOutput({ FunctionName: "f", Role: "r" } as any);
    const logGroup = new Derived("logs", { dependencies: { fn } });
    expect(await logGroup.planParams()).toEqual({
      logGroupName: "/aws/lambda/f",
    });
  });

  it("fails plan when deriveParams throws without a pending read", async () => {
    const Throws = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(() => {
      throw new Error("no");
    });
    const logGroup = new Throws("logs", {
      config: { retention: 1 },
      dependencies: { fn: fnWith() },
    });
    await expect(logGroup.planParams()).rejects.toThrow("no");
  });

  describe("an output ref that deriveParams takes from a dependency", () => {
    const Derived = LogGroup.requireDependencies<{
      fn: InstanceType<typeof Fn>;
    }>().deriveParams(({ deps }) => ({
      logGroupName: deps.fn.outputRef("FunctionArn"),
    }));

    it("plans as unknown when the dependency has no output", async () => {
      const logGroup = new Derived("logs", {
        config: { retention: 7 },
        dependencies: { fn: fnWith() },
      });
      expect(await logGroup.planParams()).toEqual({
        logGroupName: UNKNOWN_AFTER_APPLY,
        retention: 7,
      });
    });

    it("plans as unknown when the output is missing from the dependency's state", async () => {
      const fn = fnWith();
      fn.setOutput({ FunctionName: "f", Role: "r" } as any);
      const logGroup = new Derived("logs", {
        config: { retention: 7 },
        dependencies: { fn },
      });
      expect(await logGroup.planParams()).toEqual({
        logGroupName: UNKNOWN_AFTER_APPLY,
        retention: 7,
      });
    });

    it("plans the value when the dependency's state has the output", async () => {
      const Derived = LogGroup.requireDependencies<{
        fn: InstanceType<typeof Fn>;
      }>().deriveParams(({ deps }) => ({
        logGroupName: deps.fn.outputRef("FunctionName"),
      }));
      const fn = fnWith();
      fn.setOutput({ FunctionName: "f", Role: "r" } as any);
      const logGroup = new Derived("logs", {
        config: { retention: 7 },
        dependencies: { fn },
      });
      expect(await logGroup.planParams()).toEqual({
        logGroupName: "f",
        retention: 7,
      });
    });
  });

  describe("an output ref that a function contribution takes from a dependency", () => {
    const contributeRef = (
      fn: InstanceType<typeof Fn>,
      queue: InstanceType<typeof Queue>,
    ) =>
      fn.contribute(
        ({ deps }) => ({
          Environment: { Variables: { Q: deps.queue.outputRef("QueueArn") } },
        }),
        { deps: { queue } },
      );

    it("plans as unknown when the dependency has no output", async () => {
      const queue = new Queue("orders", { config: { QueueName: "orders" } });
      const fn = fnWith();
      contributeRef(fn, queue);
      expect((await fn.planParams()).Environment).toEqual({
        Variables: { Q: UNKNOWN_AFTER_APPLY },
      });
    });

    it("plans as unknown when the output is missing from the dependency's state", async () => {
      const queue = new Queue("orders", { config: { QueueName: "orders" } });
      queue.setOutput({ QueueUrl: "url", QueueName: "orders" } as any);
      const fn = fnWith();
      contributeRef(fn, queue);
      expect((await fn.planParams()).Environment).toEqual({
        Variables: { Q: UNKNOWN_AFTER_APPLY },
      });
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

describe("placeholder params", () => {
  it("leave out every contribution, and keep the config", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    queue.setOutput({ QueueUrl: "url", QueueName: "orders", QueueArn: "arn" });
    const fn = new Fn("fn", {
      config: {
        FunctionName: "f",
        Role: "role",
        Environment: { Variables: { STAGE: "dev" } },
      },
    });
    fn.contribute({
      Environment: { Variables: { QUEUE: queue.outputValue("QueueArn") } },
    });

    expect(await fn.getParams({ contributions: false })).toEqual({
      FunctionName: "f",
      Role: "role",
      Environment: { Variables: { STAGE: "dev" } },
    });
    expect((await fn.getParams()).Environment).toEqual({
      Variables: { STAGE: "dev", QUEUE: "arn" },
    });
  });

  it("leave a collected param unset when only contributions set it", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "role" } });
    fn.contribute({
      Environment: { Variables: { QUEUE: queue.outputValue("QueueArn") } },
    });

    expect(await fn.getParams({ contributions: false })).toEqual({
      FunctionName: "f",
      Role: "role",
    });
  });
});

describe("dependencies by source", () => {
  it("separate fixed dependencies from those that only contributions add", () => {
    const role = new Queue("role", { config: { QueueName: "role" } });
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const other = new Queue("other", { config: { QueueName: "other" } });
    const fn = new Fn("fn", {
      config: { FunctionName: "f", Role: role.outputValue("QueueArn") },
    });
    fn.dependOn(other);
    fn.contribute({
      Environment: { Variables: { QUEUE: queue.outputValue("QueueArn") } },
    });

    expect(fn.getFixedDependencies()).toEqual([other, role]);
    expect(fn.getDependencies()).toEqual([other, role, queue]);
  });

  it("list the collected params that contributions set", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const policy = new Policy("policy", { config: { PolicyName: "p" } });
    const plain = new Fn("plain", {
      config: { FunctionName: "p", Role: "role" },
    });
    expect(plain.getContributedParams()).toEqual([]);

    const fn = new Fn("fn", { config: { FunctionName: "f", Role: "role" } });
    fn.contribute({ Environment: { Variables: { A: "a" } } });
    expect(fn.getContributedParams()).toEqual(["Environment"]);

    policy.contribute(
      ({ deps }) => ({
        PolicyDocument: {
          Statement: [grant(deps.queue.output.QueueArn)],
        },
      }),
      { deps: { queue } },
    );
    expect(policy.getContributedParams()).toEqual(["PolicyDocument"]);
  });
});
