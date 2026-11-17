import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ContributionConflictError,
  OutputRefStringError,
  PendingOutput,
  UNKNOWN_AFTER_APPLY,
  ValueValidationError,
  all,
  credentialMarker,
  isDerived,
  isOutputRef,
  mergeContributions,
  ownPhysicalName,
  resource,
  text,
} from "src";
import { check, number, object, string } from "./validators";

type Environment = { Variables: Record<string, string> };

const hostOf = (url: string) => url.split("/")[2]!;

const Queue = resource<{
  Key: { QueueUrl: string };
  CreateParams: { QueueName: string };
  UpdateParams: {};
  ReadResult: { QueueArn: string; QueueUrl: string; Port?: number };
}>({ type: "test/derived/queue", provider: "test" })
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
    Port: { propertyType: "computed", presence: "optional", value: number() },
  })
  .defineOperations({
    create: async () => ({ QueueUrl: "url" }),
    delete: async () => undefined,
  });

const deployedQueue = (id: string) => {
  const queue = new Queue(id, { config: { QueueName: id } });
  queue.setOutput({
    QueueUrl: `https://sqs/${id}`,
    QueueName: id,
    QueueArn: `arn:${id}`,
  });
  return queue;
};

const Token = resource<{
  Key: { Id: string };
  CreateParams: { Name: string };
  UpdateParams: {};
  ReadResult: {};
}>({ type: "test/derived/token", provider: "test" })
  .defineSchema({
    Id: {
      propertyType: "computed",
      value: string(),
      presence: "required",
      primaryKey: true,
    },
    Name: {
      propertyType: "param",
      presence: "required",
      value: string(),
      immutable: true,
    },
    Value: { propertyType: "credential", value: string() },
  })
  .defineOperations({
    create: async () => ({ Id: "1", Value: "secret" }),
    delete: async () => undefined,
  });

const Fn = resource<{
  Key: { FunctionName: string };
  CreateParams: {
    FunctionName: string;
    Url: string;
    Environment?: Environment;
  };
  UpdateParams: { Url: string; Environment?: Environment };
  ReadResult: { FunctionArn: string };
}>({ type: "test/derived/function", provider: "test" })
  .defineSchema({
    FunctionName: {
      propertyType: "param",
      value: string(),
      presence: "required",
      primaryKey: true,
      immutable: true,
      physicalName: { maxLength: 64 },
    },
    Url: {
      propertyType: "param",
      presence: "required",
      value: check<string>(
        (value) => typeof value === "string" && value.startsWith("https://"),
        "Expected an https URL",
      ),
    },
    Environment: {
      propertyType: "param",
      value: object<Environment>(),
      presence: "optional",
      collect: mergeContributions,
    },
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

describe("text", () => {
  it("adds a dependency, plans as unknown at its own path before the first deploy, and is a string at deploy", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", {
      config: { Url: text`${queue.outputRef("QueueUrl")}/callback` },
    });
    fn.contribute({ Environment: { Variables: { KNOWN: "k" } } });

    expect(fn.getDependencies()).toEqual([queue]);
    expect(await fn.planParams()).toEqual({
      Url: UNKNOWN_AFTER_APPLY,
      Environment: { Variables: { KNOWN: "k" } },
    });

    queue.setOutput({
      QueueUrl: "https://sqs/orders",
      QueueName: "orders",
      QueueArn: "arn:orders",
    });
    expect(await fn.planParams()).toMatchObject({
      Url: "https://sqs/orders/callback",
    });
    expect(await fn.getParams()).toMatchObject({
      Url: "https://sqs/orders/callback",
    });
  });

  it("joins numbers and other derived values", async () => {
    const queue = deployedQueue("orders");
    const host = queue.outputRef("QueueUrl").map((url) => hostOf(url));
    const fn = new Fn("fn", {
      config: { Url: text`https://${host}:${443}/${"x"}` },
    });
    expect((await fn.getParams()).Url).toBe("https://sqs:443/x");
  });

  it("is computed and checked when declared, when it reads no ref", () => {
    const callbackFor = (base: string) => text`${base}/callback`;
    expect(
      () =>
        new Fn("ok", { config: { Url: callbackFor("https://example.com") } }),
    ).not.toThrow();
    expect(
      () =>
        new Fn("bad", { config: { Url: callbackFor("http://example.com") } }),
    ).toThrow(ValueValidationError);
  });

  it("is not checked when declared, when it reads a ref", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    expect(
      () =>
        new Fn("fn", {
          config: { Url: text`http://${queue.outputRef("QueueUrl")}` },
        }),
    ).not.toThrow();
  });

  it("fails when a part is not a string or a number", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    queue.setOutput({ QueueUrl: "u", QueueName: "orders", QueueArn: "a" });
    const fn = new Fn("fn", {
      config: {
        // @ts-expect-error an optional output can be undefined
        Url: text`https://${queue.outputRef("Port")}`,
      },
    });
    await expect(fn.getParams()).rejects.toThrow(
      /^text`…` at packages\/resource\/test\/derived\.test\.ts:\d+: orders\.Port is undefined, not a string or a number$/,
    );
  });

  it("is written in canonical form with its parts", async () => {
    const a = new Queue("a", { config: { QueueName: "a" } });
    const b = new Queue("b", { config: { QueueName: "b" } });
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: { Variables: { Q: text`${a.outputRef("QueueArn")}-*` } },
    });
    fn.contribute({
      Environment: { Variables: { Q: text`${b.outputRef("QueueArn")}-*` } },
    });
    a.setOutput({ QueueUrl: "u", QueueName: "a", QueueArn: "arn:a" });
    b.setOutput({ QueueUrl: "u", QueueName: "b", QueueArn: "arn:b" });
    const error = await fn.getParams().catch((error) => error);
    expect(error).toBeInstanceOf(ContributionConflictError);
    expect(error.message).toContain('to "arn:a-*" and "arn:b-*"');
  });
});

describe("map", () => {
  it("plans its result once the ref is known", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: {
        Variables: {
          HOST: queue.outputRef("QueueUrl").map((url) => hostOf(url)),
          KNOWN: "k",
        },
      },
    });

    expect((await fn.planParams()).Environment).toEqual({
      Variables: { HOST: UNKNOWN_AFTER_APPLY, KNOWN: "k" },
    });
    queue.setOutput({
      QueueUrl: "https://sqs.example/orders",
      QueueName: "orders",
      QueueArn: "arn",
    });
    expect((await fn.planParams()).Environment).toEqual({
      Variables: { HOST: "sqs.example", KNOWN: "k" },
    });
  });

  it("leaves the keys of a document that other contributions set known at plan", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: {
        Variables: {
          ARN: queue.outputRef("QueueArn").map((arn) => `${arn}-*`),
        },
      },
    });
    fn.contribute({ Environment: { Variables: { MODE: "fast" } } });

    expect((await fn.planParams()).Environment).toEqual({
      Variables: { ARN: UNKNOWN_AFTER_APPLY, MODE: "fast" },
    });
  });

  it("checks each function of a chain on its own", async () => {
    const queue = deployedQueue("orders");
    const fn = new Fn("fn", {
      config: {
        Url: queue
          .outputRef("QueueUrl")
          .map((url) => url.toUpperCase())
          .map((url): string => {
            throw new Error(`no ${url}`);
          }),
      },
    });
    const error = await fn.getParams().catch((error) => error);
    expect(error.message).toMatch(
      /^The function of map\(\) at packages\/resource\/test\/derived\.test\.ts:(\d+) threw: no HTTPS:\/\/SQS\/ORDERS$/,
    );
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("fails plan with the call site when the function throws", async () => {
    const queue = deployedQueue("orders");
    const fn = new Fn("fn", {
      config: {
        Url: queue.outputRef("QueueUrl").map((): string => {
          throw new Error("no");
        }),
      },
    });
    await expect(fn.planParams()).rejects.toThrow(
      /^The function of map\(\) at packages\/resource\/test\/derived\.test\.ts:\d+ threw: no$/,
    );
  });

  it("fails when the function returns a promise", async () => {
    const queue = deployedQueue("orders");
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: {
        Variables: {
          URL: queue.outputRef("QueueUrl").map(async (url) => url) as any,
        },
      },
    });
    await expect(fn.getParams()).rejects.toThrow(
      "returned a promise. The function must return its value.",
    );
  });

  it("fails when the function returns a value that state can't record, at any depth", async () => {
    class Endpoint {}
    const cases: [() => unknown, string][] = [
      [() => new (globalThis as any).URL("https://x"), "returned a URL, which"],
      [() => () => "x", "returned a function, which"],
      [() => ({ time: new Date(0) }), "returned a Date at time, which"],
      [() => [new Map()], "returned a Map at 0, which"],
      [() => ({ n: BigInt(1) }), "returned a bigint at n, which"],
      [() => Symbol("x"), "returned a symbol, which"],
      [
        () => ({ list: [new Endpoint()] }),
        "returned an Endpoint at list.0, which",
      ],
    ];
    for (const [result, message] of cases) {
      const fn = new Fn("fn", { config: { Url: "https://x" } });
      fn.contribute({
        Environment: deployedQueue("orders")
          .outputRef("QueueUrl")
          .map(result) as any,
      });
      await expect(fn.getParams()).rejects.toThrow(
        `${message} state can't record.`,
      );
    }
  });

  it("fails when the function returns a ref at any depth", async () => {
    const queue = deployedQueue("orders");
    const other = deployedQueue("other");
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: queue.outputRef("QueueUrl").map(() => ({
        Variables: { URL: other.outputRef("QueueUrl") },
      })) as any,
    });
    await expect(fn.getParams()).rejects.toThrow(
      "returned a value that holds an output ref or a derived value",
    );
  });

  it("is not called at plan with a value that plan gives as unknown", async () => {
    const queue = deployedQueue("orders");
    queue.setOutput({ ...queue.output, QueueUrl: UNKNOWN_AFTER_APPLY } as any);
    const compute = vi.fn((url: string) => `${url}/x`);
    const fn = new Fn("fn", {
      config: { Url: queue.outputRef("QueueUrl").map(compute) },
    });
    expect((await fn.planParams()).Url).toEqual(UNKNOWN_AFTER_APPLY);
    expect(compute).not.toHaveBeenCalled();
  });

  it("is called with real values, and more than once", async () => {
    const queue = deployedQueue("orders");
    const compute = vi.fn((url: string) => `${url}/x`);
    const fn = new Fn("fn", {
      config: { Url: queue.outputRef("QueueUrl").map(compute) },
    });
    await fn.planParams();
    await fn.getParams();
    expect(compute).toHaveBeenCalledWith("https://sqs/orders");
    expect(compute.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("finds a conflict between two mapped values at one path at deploy", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    const arn = queue.outputRef("QueueArn");
    fn.contribute({
      Environment: { Variables: { Q: arn.map((a) => `${a}-1`) } },
    });
    fn.contribute({
      Environment: { Variables: { Q: arn.map((a) => `${a}-2`) } },
    });

    expect((await fn.planParams()).Environment).toEqual({
      Variables: { Q: UNKNOWN_AFTER_APPLY },
    });
    queue.setOutput({ QueueUrl: "u", QueueName: "orders", QueueArn: "arn" });
    await expect(fn.getParams()).rejects.toThrow(
      'both set Environment.Variables.Q, to "arn-1" and "arn-2"',
    );
  });

  it("is written in canonical form with its ref and call site", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const mapped = queue.outputRef("QueueArn").map((arn) => arn);
    expect(() => String(mapped)).toThrow(
      /^Derived value <map of orders\.QueueArn at packages\/resource\/test\/derived\.test\.ts:\d+>: a derived value can't be turned into a string/,
    );
  });

  it("fails where the params are read when it reads the own name of its resource", async () => {
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute({
      Environment: {
        Variables: {
          NAME: fn.outputRef("FunctionName").map((name) => name.toUpperCase()),
        },
      },
    });
    expect(fn.getDependencies()).toEqual([]);
    await expect(fn.getParams()).rejects.toThrow(
      /reads fn\.FunctionName, the physical name of fn itself/,
    );
  });
});

describe("all", () => {
  it("depends on each resource it reads, and gives the list of their values", async () => {
    const a = new Queue("a", { config: { QueueName: "a" } });
    const b = new Queue("b", { config: { QueueName: "b" } });
    const fn = new Fn("fn", {
      config: {
        Url: all([a.outputRef("QueueUrl"), b.outputRef("QueueArn")]).map(
          ([url, arn]) => `${url}?arn=${arn}`,
        ),
      },
    });
    expect(fn.getDependencies()).toEqual([a, b]);

    a.setOutput({ QueueUrl: "https://a", QueueName: "a", QueueArn: "arn:a" });
    expect((await fn.planParams()).Url).toBe(UNKNOWN_AFTER_APPLY);
    b.setOutput({ QueueUrl: "https://b", QueueName: "b", QueueArn: "arn:b" });
    expect((await fn.getParams()).Url).toBe("https://a?arn=arn:b");
  });
});

describe("text, map and all", () => {
  it("reject a credential", () => {
    const token = new Token("token", { config: { Name: "t" } });
    const credential = token.credentials.Value;
    expect(() => text`${credential as any}`).toThrow(
      /^text`…` at packages\/resource\/test\/derived\.test\.ts:\d+ reads the credential token\.Value\. A credential can only be placed whole/,
    );
    expect(() => all([credential as any])).toThrow(
      /^all\(\) at packages\/resource\/test\/derived\.test\.ts:\d+ reads the credential token\.Value/,
    );
    expect(() => (credential as any).map((value: string) => value)).toThrow(
      /^map\(\) at .+ reads the credential token\.Value/,
    );
  });

  it("reject a ~state ref", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const recorded = queue["~state"].outputRef("QueueName");
    expect(() => text`${recorded as any}`).toThrow(
      "reads the ~state ref orders.QueueName. A ~state ref can only be placed whole in a contribution.",
    );
    expect(() => all([recorded as any])).toThrow(
      /^all\(\) at .+ reads the ~state ref orders\.QueueName/,
    );
    expect(() => (recorded as any).map((value: string) => value)).toThrow(
      "reads the ~state ref orders.QueueName",
    );
  });

  it("make a value that is not an output ref", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const derived = text`${queue.outputRef("QueueArn")}`;
    expect(isDerived(derived)).toBe(true);
    expect(isOutputRef(derived)).toBe(false);
    expect(isOutputRef(queue.outputRef("QueueArn"))).toBe(true);
  });

  it("throw when turned into a string", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const ref = queue.outputRef("QueueArn");
    const joined = text`${ref}-*`;
    expect(() => `${joined}`).toThrow(OutputRefStringError);
    expect(() => `${joined}`).toThrow(
      "Derived value <output orders.QueueArn>-*: a derived value can't be turned into a string. Place it whole, join it with text`…`, or compute with it in map().",
    );
    expect(() => JSON.stringify({ joined })).toThrow(OutputRefStringError);
    expect(() => `${ref}`).toThrow(
      "Output orders.QueueArn: an output ref can't be turned into a string. Place it whole, join it with text`…`, or compute with it in map().",
    );
  });
});

describe("deriveParams", () => {
  const alarm = () =>
    resource<{
      Key: { AlarmName: string };
      CreateParams: { AlarmName: string; Target: string; Host: string };
      UpdateParams: { Target: string; Host: string };
      ReadResult: {};
    }>({ type: "test/derived/alarm", provider: "test" }).defineSchema({
      AlarmName: {
        propertyType: "param",
        value: string(),
        presence: "required",
        primaryKey: true,
        immutable: true,
      },
      Target: { propertyType: "param", value: string(), presence: "required" },
      Host: { propertyType: "param", value: string(), presence: "required" },
    });
  const operations = {
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  };
  const Alarm = alarm().defineOperations({
    ...operations,
    deriveParams: ({ config }) => ({ Host: hostOf(config.Target!) }),
  });
  const Plain = alarm().defineOperations(operations);

  it("receives a config ref as its value at deploy", async () => {
    const queue = deployedQueue("orders");
    const alarm = new Alarm("alarm", {
      config: { AlarmName: "a", Target: queue.outputRef("QueueUrl") },
    });
    expect(await alarm.getParams()).toEqual({
      AlarmName: "a",
      Target: "https://sqs/orders",
      Host: "sqs",
    });
  });

  it("makes the params it would derive unknown at plan when it reads an unknown ref", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const alarm = new Alarm("alarm", {
      config: { AlarmName: "a", Target: queue.outputRef("QueueUrl") },
    });
    expect(await alarm.planParams()).toEqual({
      AlarmName: "a",
      Target: UNKNOWN_AFTER_APPLY,
      Host: UNKNOWN_AFTER_APPLY,
    });
  });

  it("receives a known ref at plan as its value", async () => {
    const queue = deployedQueue("orders");
    const alarm = new Alarm("alarm", {
      config: {
        AlarmName: "a",
        Target: text`${queue.outputRef("QueueUrl")}/x`,
      },
    });
    expect(await alarm.planParams()).toEqual({
      AlarmName: "a",
      Target: "https://sqs/orders/x",
      Host: "sqs",
    });
  });

  it("throws PendingOutput at plan on an unknown read, and plans exactly without one", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const read: unknown[] = [];
    const Probe = Plain.requireDependencies<{}>().deriveParams(({ config }) => {
      read.push(config.AlarmName);
      try {
        read.push(config.Target);
      } catch (error) {
        read.push(error);
      }
      return { Host: "h" };
    });
    const probe = new Probe("probe", {
      config: { AlarmName: "a", Target: queue.outputRef("QueueUrl") },
    });
    expect(await probe.planParams()).toMatchObject({
      Host: UNKNOWN_AFTER_APPLY,
    });
    expect(read[0]).toBe("a");
    expect(read[1]).toBeInstanceOf(PendingOutput);
    expect((read[1] as PendingOutput).resource).toBe(queue);
  });

  it("receives the config of its deps with refs filled in", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const target = new Alarm("target", {
      config: { AlarmName: "t", Target: queue.outputRef("QueueUrl") },
    });
    const Watcher = Plain.requireDependencies<{
      target: InstanceType<typeof Alarm>;
      other?: InstanceType<typeof Alarm>;
    }>().deriveParams(({ deps }) => {
      expectTypeOf(deps.other?.config.Target).toEqualTypeOf<
        string | undefined
      >();
      return {
        Target: deps.target.config.Target,
        Host: hostOf(deps.target.config.Target),
      };
    });
    const watcher = new Watcher("watcher", {
      config: { AlarmName: "w" },
      dependencies: { target },
    });
    target.setOutput({ AlarmName: "t", Target: "x", Host: "x" });

    expect(await watcher.planParams()).toEqual({
      AlarmName: "w",
      Target: UNKNOWN_AFTER_APPLY,
      Host: UNKNOWN_AFTER_APPLY,
    });
    queue.setOutput({
      QueueUrl: "https://sqs/orders",
      QueueName: "orders",
      QueueArn: "arn",
    });
    expect(await watcher.planParams()).toEqual({
      AlarmName: "w",
      Target: "https://sqs/orders",
      Host: "sqs",
    });
    expect(await watcher.getParams()).toEqual({
      AlarmName: "w",
      Target: "https://sqs/orders",
      Host: "sqs",
    });
  });
});

describe("function contributions", () => {
  it("receive the config of their deps with refs filled in, at plan and at deploy", async () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const target = new Fn("target", {
      config: { Url: text`${queue.outputRef("QueueUrl")}/x` },
    });
    target.setOutput({ FunctionName: "target", FunctionArn: "arn" } as any);
    const fn = new Fn("fn", { config: { Url: "https://x" } });
    fn.contribute(
      ({ deps }) => ({
        Environment: {
          // The type of a function contribution's deps leaves config as
          // inputs, but deploy and plan give its refs filled in.
          Variables: { HOST: hostOf(deps.target.config.Url as string) },
        },
      }),
      { deps: { target } },
    );

    expect((await fn.planParams()).Environment).toEqual(UNKNOWN_AFTER_APPLY);
    queue.setOutput({
      QueueUrl: "https://sqs/orders",
      QueueName: "orders",
      QueueArn: "arn",
    });
    const expected = { Variables: { HOST: "sqs" } };
    expect((await fn.planParams()).Environment).toEqual(expected);
    expect((await fn.getParams()).Environment).toEqual(expected);
  });
});

describe("deriveParams with a marker in config", () => {
  type NamedConfig = { Label?: string | string[]; Secret?: string };
  const named = (
    type: `${string}/${string}/${string}`,
    derive: (config: NamedConfig) => NamedConfig,
  ) =>
    resource<{
      Key: { Name: string };
      CreateParams: { Name: string } & NamedConfig;
      UpdateParams: NamedConfig;
      ReadResult: {};
    }>({ type, provider: "test" })
      .defineSchema({
        Name: {
          propertyType: "param",
          value: string(),
          presence: "required",
          primaryKey: true,
          immutable: true,
          physicalName: { maxLength: 64 },
        },
        Label: {
          propertyType: "param",
          value: object<string | string[]>(),
          presence: "optional",
        },
        Secret: {
          propertyType: "param",
          value: string(),
          presence: "optional",
        },
      })
      .defineOperations({
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        deriveParams: ({ config }) => derive(config),
      });
  const Reader = named("test/derived/reader", (config) => ({
    Label: `${config.Label}${config.Secret ?? ""}`,
  }));
  const Passer = named("test/derived/passer", () => ({}));

  const deployedToken = () => {
    const token = new Token("token", { config: { Name: "t" } });
    // Deploy records a credential in the output as a marker.
    token.setOutput({
      Id: "1",
      Name: "t",
      Value: credentialMarker("token", "Value", "v1"),
    } as { Id: string; Name: string });
    return token;
  };

  it("throws when deriveParams reads the resource's own physical name", async () => {
    const reader = new Reader("reader");
    (reader.config as Record<string, unknown>).Label = [
      reader.outputRef("Name"),
    ];
    const message =
      "reader.Label.0 is the physical name of reader itself, which deploy decides after the params, so deriveParams can't read it.";
    await expect(reader.getParams()).rejects.toThrow(message);
    await expect(reader.planParams()).rejects.toThrow(message);
  });

  it("throws when deriveParams reads a credential", async () => {
    const reader = new Reader("reader", {
      config: { Label: ["x"], Secret: deployedToken().credentials.Value },
    });
    const message =
      "reader.Secret is the credential token.Value, which deploy puts in the params only for the call to an operation, so deriveParams can't read it.";
    await expect(reader.getParams()).rejects.toThrow(message);
    await expect(reader.planParams()).rejects.toThrow(message);
  });

  it("plans as unknown when deriveParams reads a credential that deploy rotates", async () => {
    const token = deployedToken();
    // Plan gives this for a credential that it expects deploy to rotate.
    token.setOutput({ ...token.output, Value: UNKNOWN_AFTER_APPLY } as any);
    let read: unknown;
    const Probe = Passer.requireDependencies<{}>().deriveParams(
      ({ config }) => {
        try {
          return { Label: (config as NamedConfig).Secret };
        } catch (error) {
          read = error;
          throw error;
        }
      },
    );
    const probe = new Probe("probe", {
      config: { Name: "p", Secret: token.credentials.Value },
    });
    expect(await probe.planParams()).toMatchObject({
      Label: UNKNOWN_AFTER_APPLY,
    });
    expect(read).toBeInstanceOf(PendingOutput);
    expect((read as PendingOutput).resource).toBe(probe);
    expect((read as PendingOutput).message).toBe(
      "probe.Secret is not known until deploy",
    );
  });

  it("guards the markers in the config of a dependency", async () => {
    const source = new Passer("source", {
      config: { Name: "s", Secret: deployedToken().credentials.Value },
    });
    source.setOutput({ Name: "s" });
    const Watcher = Passer.requireDependencies<{
      source: InstanceType<typeof Passer>;
    }>().deriveParams(({ deps }) => ({
      Label: (deps.source.config as NamedConfig).Secret,
    }));
    const watcher = new Watcher("watcher", {
      config: { Name: "w" },
      dependencies: { source },
    });
    const message =
      "source.Secret is the credential token.Value, which deploy puts in the params only for the call to an operation, so deriveParams can't read it.";
    await expect(watcher.getParams()).rejects.toThrow(message);
    await expect(watcher.planParams()).rejects.toThrow(message);
  });

  it("plans as unknown when deriveParams reads a rotated credential in the config of a dependency", async () => {
    const token = deployedToken();
    token.setOutput({ ...token.output, Value: UNKNOWN_AFTER_APPLY } as any);
    const source = new Passer("source", {
      config: { Name: "s", Secret: token.credentials.Value },
    });
    source.setOutput({ Name: "s" });
    const Watcher = Passer.requireDependencies<{
      source: InstanceType<typeof Passer>;
    }>().deriveParams(({ deps }) => ({
      Label: `secret: ${(deps.source.config as NamedConfig).Secret}`,
    }));
    const watcher = new Watcher("watcher", {
      config: { Name: "w" },
      dependencies: { source },
    });
    expect(await watcher.planParams()).toMatchObject({
      Label: UNKNOWN_AFTER_APPLY,
    });
  });

  it("keeps the markers in the params when deriveParams doesn't read them", async () => {
    const passer = new Passer("passer", {
      config: { Secret: deployedToken().credentials.Value },
    });
    (passer.config as Record<string, unknown>).Label = passer.outputRef("Name");
    const expected = {
      Label: ownPhysicalName("Name"),
      Secret: credentialMarker("token", "Value", "v1"),
    };
    expect(await passer.getParams()).toEqual(expected);
    expect(await passer.planParams()).toEqual(expected);
  });
});

describe("outputRef", () => {
  it("throws for a credential, and points to credentials", () => {
    const token = new Token("token", { config: { Name: "t" } });
    expect(() => token.outputRef("Value" as any)).toThrow(
      "Value of token is a credential. Use token.credentials.Value for a ref to it.",
    );
  });
});
