import { expect, expectTypeOf, test } from "vitest";
import type { EventBridgeEvent } from "aws-lambda";
import { eventBridge as iac, lambda as iacLambda } from "src/resources";
import {
  collectResourceGraph,
  type ResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import {
  defaultEventBus,
  eventBus,
  rate,
  rule,
  RuleGroup,
  schedule,
} from "src/event-bridge";
import {
  $lambda,
  DecodeError,
  eventBridge,
  lambda,
  type LambdaGroup,
  type LambdaHandler,
  sqs,
} from "src/lambda";
import * as runtime from "src/lambda/runtime";
import { inModule, lambdaGroup, Unknown } from "./declare";

type Order = { orderId: string };

const OrderPlaced: StandardSchemaV1<unknown, Order> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as any)?.orderId === "string"
        ? { value: value as Order }
        : { issues: [{ message: "orderId must be a string" }] },
  },
};

const pattern = { source: ["shop"], "detail-type": ["OrderPlaced"] };

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

const ruleGroup = (graph: ResourceGraph, id: string) =>
  graph.resourceGroups.find(
    (g): g is RuleGroup => g instanceof RuleGroup && g.id === id,
  )!;

// The rules that a function's permissions name in their SourceArn.
const permissionsOf = (fn: LambdaGroup) =>
  fn.resources
    .filter((r) => r instanceof iacLambda.LambdaPermission)
    .flatMap((r) =>
      r.getDependencies().filter((d) => d instanceof iac.EventBridgeRule),
    );

const event = (detail: unknown) =>
  ({
    "detail-type": "OrderPlaced",
    source: "shop",
    detail,
  }) as EventBridgeEvent<string, unknown>;

test("eventBus() declares a bus keyed by the id", async () => {
  let orders!: ReturnType<typeof eventBus>;
  await collectResourceGraph(() => {
    orders = eventBus({ id: "orders" });
  });

  expect(orders.bus).toBeInstanceOf(iac.EventBus);
  expect(orders.bus.id).toBe("eventbridge-bus:orders");
});

test("a bus's grant allows the actions on the bus's ARN", () => {
  const orders = eventBus({ id: "orders" });

  expect(orders.grant(["PutEvents"])).toEqual({
    Effect: "Allow",
    Action: ["events:PutEvents"],
    Resource: orders.arn,
  });
});

test("a rule takes its bus name from the bus's Name output", async () => {
  let orders!: ReturnType<typeof eventBus>;
  const graph = await collectResourceGraph(() => {
    orders = eventBus({ id: "orders" });
    rule({
      id: "order-placed",
      bus: orders,
      pattern,
      target: lambda({ id: "fulfil", code }),
    });
  });
  const fn = lambdaGroup(graph, "fulfil");
  fn.fn.setOutput({ FunctionName: "fulfil", FunctionArn: "arn:fn" } as any);
  orders.bus.setOutput({ Name: "shop--prod--orders-1a2b3c4d" } as any);

  const params = await ruleGroup(graph, "order-placed").rule.getParams();
  expect(params.EventBusName).toBe("shop--prod--orders-1a2b3c4d");
});

test("defaultEventBus() returns the same bus for each call", async () => {
  const graph = await collectResourceGraph(() => {
    expect(defaultEventBus()).toBe(defaultEventBus());
  });

  expect(
    graph.resources.filter((r) => r instanceof iac.DefaultEventBus),
  ).toHaveLength(1);
});

test("rule() sends the events of a pattern on a bus to a declaration with eventBridge.schema()", async () => {
  let orders!: ReturnType<typeof eventBus>;
  const graph = await collectResourceGraph(() => {
    orders = eventBus({ id: "orders" });
    const fn = inModule(
      $lambda({ id: "fulfil", event: () => eventBridge.schema(OrderPlaced) }),
    );
    rule({
      id: "order-placed",
      bus: orders,
      pattern,
      target: () => fn,
    });
  });
  const fn = lambdaGroup(graph, "fulfil");
  const placed = ruleGroup(graph, "order-placed");

  expect(placed.rule.id).toBe("eventbridge-pattern-rule:order-placed");
  expect(placed.rule.config).toMatchObject({
    EventBusName: orders.name,
    EventPattern: JSON.stringify(pattern),
    State: "ENABLED",
  });
  expect(placed.rule.config.ScheduleExpression).toBeUndefined();
  expect(placed.rule.dependencies).toEqual({
    lambda: fn.fn,
    eventBus: orders.bus,
  });
  expect(permissionsOf(fn)).toEqual([placed.rule]);
});

test("a rule targets the function, with the retry policy", async () => {
  let fn!: LambdaGroup;
  const graph = await collectResourceGraph(() => {
    fn = lambda({ id: "fulfil", code });
    rule({
      id: "order-placed",
      bus: defaultEventBus(),
      pattern,
      enabled: false,
      retry: { maxAttempts: 3 },
      target: fn,
    });
    defaultEventBus().bus.setOutput({ Name: "default" } as any);
  });
  fn.fn.setOutput({ FunctionName: "fulfil", FunctionArn: "arn:fn" } as any);
  const placed = ruleGroup(graph, "order-placed");

  const params = await placed.rule.getParams();
  expect(params.EventBusName).toBe("default");
  expect(params.State).toBe("DISABLED");
  expect(params.Targets).toEqual([
    {
      Id: "fulfil",
      Arn: "arn:fn",
      RetryPolicy: {
        MaximumRetryAttempts: 3,
        MaximumEventAgeInSeconds: 86_400,
      },
    },
  ]);
});

test("a rule with no retry option sends no retry policy", async () => {
  let fn!: LambdaGroup;
  const graph = await collectResourceGraph(() => {
    fn = lambda({ id: "fulfil", code });
    rule({
      id: "order-placed",
      bus: defaultEventBus(),
      pattern,
      target: fn,
    });
    defaultEventBus().bus.setOutput({ Name: "default" } as any);
  });
  fn.fn.setOutput({ FunctionName: "fulfil", FunctionArn: "arn:fn" } as any);

  const params = await ruleGroup(graph, "order-placed").rule.getParams();
  expect(params.State).toBe("ENABLED");
  expect(params.Targets).toEqual([{ Id: "fulfil", Arn: "arn:fn" }]);
});

test("rule() of a declaration with an sqs event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.schema(OrderPlaced) }),
      );
      rule({
        id: "order-placed",
        bus: defaultEventBus(),
        pattern,
        // @ts-expect-error a rule can't invoke a function of SQS messages
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'rule() sends eventBridge events, but the Lambda "process" is declared with event: () => sqs.schema(schema).',
  );
});

test("rule() takes a declaration with no event", async () => {
  const graph = await collectResourceGraph(() => {
    const fn = inModule($lambda({ id: "fulfil" }));
    rule({
      id: "order-placed",
      bus: defaultEventBus(),
      pattern,
      target: () => fn,
    });
  });

  expect(permissionsOf(lambdaGroup(graph, "fulfil"))).toHaveLength(1);
});

test("rule() of a declaration with eventBridge.schema(null) throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({ id: "digest", event: () => eventBridge.schema(null) }),
      );
      rule({
        id: "order-placed",
        bus: defaultEventBus(),
        pattern,
        // @ts-expect-error the declaration receives scheduled events
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'rule() sends the events of a rule, but the Lambda "digest" is declared with event: () => eventBridge.schema(null), which receives scheduled events.',
  );
});

test("a rule with an empty pattern throws", async () => {
  await expect(
    collectResourceGraph(() => {
      rule({
        id: "everything",
        bus: defaultEventBus(),
        pattern: {},
        target: lambda({ id: "fn", code }),
      });
    }),
  ).rejects.toThrow(
    'rule() with id "everything" needs a pattern that names at least one field',
  );
});

test.each([
  ["undefined", undefined],
  ["object", {}],
])(
  "rule() with a bus that is %s throws, and names the rule",
  async (kind, bus) => {
    await expect(
      collectResourceGraph(() => {
        rule({
          id: "order-placed",
          bus: bus as any,
          pattern,
          target: lambda({ id: "fn", code }),
        });
      }),
    ).rejects.toThrow(
      `rule() with id "order-placed" needs a bus from eventBus() or defaultEventBus(), but its bus is ${kind}.`,
    );
  },
);

test.each([
  [{ maxAttempts: 186 }, "retry.maxAttempts: 186"],
  [{ maxAttempts: 1.5 }, "retry.maxAttempts: 1.5"],
  [{ maxEventAge: 59 }, "retry.maxEventAge: 59"],
  [{ maxEventAge: 86_401 }, "retry.maxEventAge: 86401"],
])("a rule with retry %o throws", async (retry, message) => {
  await expect(
    collectResourceGraph(() => {
      rule({
        id: "order-placed",
        bus: defaultEventBus(),
        pattern,
        retry,
        target: lambda({ id: "fn", code }),
      });
    }),
  ).rejects.toThrow(`rule() with id "order-placed" sets ${message}.`);
});

test("eventBridge.bind(bus).defineRule() in a declaration makes the rule and the permission", async () => {
  let orders!: ReturnType<typeof eventBus>;
  const graph = await collectResourceGraph(() => {
    orders = eventBus({ id: "orders" });
    inModule(
      $lambda({
        id: "fulfil",
        event: () =>
          eventBridge.bind(orders).defineRule({
            id: "order-placed",
            pattern,
            schema: OrderPlaced,
          }),
      }),
    );
  });
  const fn = lambdaGroup(graph, "fulfil");
  const placed = ruleGroup(graph, "order-placed");

  expect(placed.rule.config.EventBusName).toEqual(orders.name);
  expect(placed.rule.dependencies.lambda).toBe(fn.fn);
  expect(permissionsOf(fn)).toEqual([placed.rule]);
});

test("a declaration's rule names eventBridge.bind(bus).defineRule() in errors", async () => {
  await expect(
    collectResourceGraph(() => {
      inModule(
        $lambda({
          id: "fulfil",
          event: () =>
            eventBridge.bind(defaultEventBus()).defineRule({
              id: "order-placed",
              pattern: {},
              schema: OrderPlaced,
            }),
        }),
      );
    }),
  ).rejects.toThrow(
    'eventBridge.bind(bus).defineRule() with id "order-placed" needs a pattern',
  );
});

test("rule() of a declaration that makes its own rule throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({
          id: "fulfil",
          event: () =>
            eventBridge.bind(defaultEventBus()).defineRule({
              id: "order-placed",
              pattern,
              schema: OrderPlaced,
            }),
        }),
      );
      rule({
        id: "orders",
        bus: defaultEventBus(),
        pattern,
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'rule() can\'t wire the Lambda "fulfil", because the Lambda makes its own rule in its declaration, with event: () => eventBridge.bind(bus).defineRule(options). Make the rule in one place: remove the rule() call, or declare the Lambda with event: () => eventBridge.schema(schema).',
  );
});

test("eventBridge.bind(bus).defineRule() takes the {} that the runtime build passes for the bus", () => {
  expect(
    runtime.eventBridge
      .bind({} as any)
      .defineRule({ id: "order-placed", pattern, schema: OrderPlaced }),
  ).toMatchObject({ kind: "eventBridge", schema: OrderPlaced });
});

test.each([
  [
    "eventBridge.bind(bus).defineRule()",
    () =>
      runtime.eventBridge
        .bind({} as any)
        .defineRule({ id: "order-placed", pattern, schema: OrderPlaced }),
  ],
  ["eventBridge.schema()", () => runtime.eventBridge.schema(OrderPlaced)],
])("decode() validates the detail of %s", async (_, declared) => {
  const fn = runtime.$lambda({ id: "fulfil", event: declared });

  await expect(fn.decode(event({ orderId: "a" }))).resolves.toEqual(
    event({ orderId: "a" }),
  );
  const error = await fn.decode(event({})).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error).toMatchObject({
    message: "The event detail is not valid: orderId must be a string",
    part: "detail",
  });
});

test("a declaration with a detail schema types its handler and decode()", () => {
  const fn = $lambda({
    id: "fulfil",
    event: () => eventBridge.schema(OrderPlaced),
  });
  const digest = $lambda({
    id: "digest",
    event: () => eventBridge.schema(null),
  });

  expectTypeOf<Parameters<LambdaHandler<typeof fn>>[0]>().toEqualTypeOf<
    EventBridgeEvent<string, unknown>
  >();
  expectTypeOf<Parameters<LambdaHandler<typeof digest>>[0]>().toEqualTypeOf<
    EventBridgeEvent<"Scheduled Event", unknown>
  >();
  const decodeEvent = (item: EventBridgeEvent<string, unknown>) =>
    fn.decode(item);
  type Decoded = Awaited<ReturnType<typeof decodeEvent>>;
  expectTypeOf<Decoded["detail"]>().toEqualTypeOf<Order>();
  expectTypeOf<Decoded["source"]>().toEqualTypeOf<string>();
  expectTypeOf(digest.decode).toBeNever();
});

test("eventBridge.bind(bus).defineRule() needs a pattern and a schema", () => {
  // Only type-checked.
  const typeOnly = () => {
    const bus = defaultEventBus();
    // @ts-expect-error the schema is missing
    eventBridge.bind(bus).defineRule({ id: "a", pattern });
    // @ts-expect-error the pattern is missing
    eventBridge.bind(bus).defineRule({ id: "a", schema: OrderPlaced });
    // @ts-expect-error the id must be name-safe
    eventBridge.bind(bus).defineRule({ id: "a b", pattern, schema: Unknown });
  };
  void typeOnly;
});
