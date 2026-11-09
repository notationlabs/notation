import { expect, expectTypeOf, test } from "vitest";
import type { EventBridgeEvent } from "aws-lambda";
import { eventBridge as iac } from "@notation/aws.iac";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import {
  collectResourceGraph,
  type BaseResource,
  type DurableObject,
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

const Refund: StandardSchemaV1<unknown, { refundId: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as { refundId: string } }),
  },
};

const pattern = { source: ["shop"], "detail-type": ["OrderPlaced"] };

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

const ruleGroup = (graph: ResourceGraph, id: string) =>
  graph.resourceGroups.find(
    (g): g is RuleGroup => g instanceof RuleGroup && g.id === id,
  )!;

const permissionsOf = (fn: LambdaGroup) =>
  fn.resources
    .filter((r) => r instanceof iac.LambdaEventBridgeRulePermission)
    .map((r) => r.dependencies.eventBridgeRule);

const event = (detail: unknown) =>
  ({
    "detail-type": "OrderPlaced",
    source: "shop",
    detail,
  }) as EventBridgeEvent<string, unknown>;

test("eventBus() declares a bus named after the app, the stage and the id", async () => {
  let orders!: ReturnType<typeof eventBus>;
  await collectResourceGraph(() => {
    orders = eventBus({ id: "orders" });
  });

  expect(orders.bus).toBeInstanceOf(iac.EventBus);
  expect(orders.bus.id).toBe("eventbridge-bus:orders");
  expect(orders.bus.config.Name).toBe(orders.busName);
});

test("a bus's grant allows the actions on the bus's ARN", () => {
  const orders = eventBus({ id: "orders" });

  expect(orders.grant(["PutEvents"])).toEqual({
    Effect: "Allow",
    Action: ["events:PutEvents"],
    Resource: orders.arn,
  });
});

test("a bus whose AWS name is another bus's throws, and names both declarations", async () => {
  await expect(
    collectResourceGraph(() => {
      eventBus({ id: "orders" });
      eventBus({ id: "shop", name: "orders" });
    }),
  ).rejects.toThrow(
    'eventBus({ id: "orders" }) and eventBus({ id: "shop", name: "orders" }) give two EventBridge event buses the same AWS name',
  );
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
      schema: OrderPlaced,
      target: () => fn,
    });
  });
  const fn = lambdaGroup(graph, "fulfil");
  const placed = ruleGroup(graph, "order-placed");

  expect(placed.rule.id).toBe("eventbridge-pattern-rule:order-placed");
  expect(placed.rule.config).toMatchObject({
    EventBusName: orders.busName,
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

test("renaming a bus replaces the rules on it, and leaves their permissions and a function with the bus name in env in place", async () => {
  let orders!: ReturnType<typeof eventBus>;
  const graph = await collectResourceGraph(() => {
    orders = eventBus({ id: "orders", name: "shop" });
    const fn = inModule(
      $lambda({
        id: "fulfil",
        event: () => eventBridge.schema(OrderPlaced),
        env: () => ({ BUS: orders.name }),
      }),
    );
    rule({
      id: "order-placed",
      bus: orders,
      pattern,
      schema: OrderPlaced,
      target: () => fn,
    });
  });
  const fn = lambdaGroup(graph, "fulfil");
  const placed = ruleGroup(graph, "order-placed");
  const [permission] = fn.resources.filter(
    (r) => r instanceof iac.LambdaEventBridgeRulePermission,
  );
  // The role and the archive are not part of this plan.
  fn.role.setOutput({ Arn: "arn:aws:iam::123456789012:role/fulfil" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "fulfil.zip",
    fileSha256: "sha",
  } as any);

  // State as the deploy before the rename left it, when the bus was named
  // after its id.
  const oldName = orders.bus.config.Name.replace("shop", "orders");
  orders.bus.setOutput({
    Name: oldName,
    Arn: `arn:aws:events:eu-west-2:123456789012:event-bus/${oldName}`,
  });
  const fnOutput = {
    ...(await fn.fn.getParams()),
    FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:fulfil",
  };
  fn.fn.setOutput(fnOutput as any);
  const ruleOutput = {
    ...(await placed.rule.getParams()),
    Arn: `arn:aws:events:eu-west-2:123456789012:rule/${oldName}/order-placed`,
  };
  placed.rule.setOutput(ruleOutput as any);
  const record = async (resource: BaseResource, output?: DurableObject) => {
    const params = await resource.getParams();
    return {
      version: 1,
      id: resource.id,
      type: resource.type,
      config: {},
      params,
      output: output ?? params,
      dependsOn: [
        ...new Set(
          resource.getDependencies().map((dependency) => dependency.id),
        ),
      ].sort(),
      lastOperation: "create" as const,
      lastOperationAt: "2026-11-01T00:00:00.000Z",
    };
  };
  const state = new MemoryStateBackend({
    [orders.bus.id]: {
      ...(await record(orders.bus, orders.bus.output as any)),
      params: { Name: oldName },
    },
    [fn.fn.id]: await record(fn.fn, fnOutput),
    [placed.rule.id]: await record(placed.rule, ruleOutput),
    [permission!.id]: await record(permission!),
  });
  expect((await state.get(fn.fn.id))!.params.Environment).toEqual({
    Variables: { BUS: oldName },
  });

  const plan = await createPlan({
    resources: [orders.bus, fn.fn, placed.rule, permission!],
    state,
    driftDetection: false,
  });
  const nodeOf = (resource: BaseResource) =>
    plan.nodes.find((node) => node.id === resource.id)!;

  expect(nodeOf(orders.bus)).toMatchObject({
    decision: "replace",
    replaceFields: [{ name: "Name", known: true }],
  });
  expect(nodeOf(placed.rule)).toMatchObject({
    decision: "replace",
    replacedDependency: orders.bus.id,
  });
  // The bus's name is unknown until the bus is created again, and the
  // function's environment can be updated in place.
  expect(nodeOf(fn.fn)).toMatchObject({ decision: "update" });
  for (const resource of [fn.fn, permission!]) {
    expect(nodeOf(resource)).not.toHaveProperty("replacedDependency");
  }
});

test("renaming a Lambda role does not replace its dependents with it", async () => {
  let fn!: LambdaGroup;
  await collectResourceGraph(() => {
    fn = lambda({ id: "fulfil", code });
  });
  const [zip, attachment, logGroup] = [
    "lambda:fulfil:zip",
    "lambda:fulfil:policy-attachment",
    "lambda:fulfil:log-group",
  ].map((id) => fn.resources.find((r) => r.id === id));
  // The archive is built already, and is not part of this plan.
  zip!.setOutput({ filePath: "fulfil.zip", fileSha256: "sha" });

  // State as the deploy before the rename left it, with params read against
  // the outputs of the old role.
  const oldName = `old-${fn.role.config.RoleName}`;
  const oldRole = {
    ...(await fn.role.getParams()),
    RoleName: oldName,
    Arn: `arn:aws:iam::123456789012:role/${oldName}`,
  };
  fn.role.setOutput(oldRole as any);
  const fnOutput = {
    ...(await fn.fn.getParams()),
    FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:fulfil",
  };
  fn.fn.setOutput(fnOutput as any);
  const record = async (resource: BaseResource, output?: DurableObject) => {
    const params = await resource.getParams();
    return {
      version: 1,
      id: resource.id,
      type: resource.type,
      config: {},
      params,
      output: output ?? params,
      dependsOn: [
        ...new Set(
          resource.getDependencies().map((dependency) => dependency.id),
        ),
      ].sort(),
      lastOperation: "create" as const,
      lastOperationAt: "2026-11-01T00:00:00.000Z",
    };
  };
  const state = new MemoryStateBackend({
    [fn.role.id]: { ...(await record(fn.role, oldRole)), params: oldRole },
    [attachment!.id]: await record(attachment!),
    [fn.fn.id]: await record(fn.fn, fnOutput),
    [logGroup!.id]: await record(logGroup!),
  });

  const plan = await createPlan({
    resources: [fn.role, attachment!, fn.fn, logGroup!],
    state,
    driftDetection: false,
  });

  // The role's outputs are unknown until it is created again, so each
  // dependent plans against unknown params, and may be replaced for its own
  // immutable fields. Deploy decides again with real params.
  expect(plan.nodes[0]).toMatchObject({
    id: fn.role.id,
    decision: "replace",
    replaceFields: [{ name: "RoleName", known: true }],
  });
  for (const node of plan.nodes.slice(1)) {
    expect(node).not.toHaveProperty("replacedDependency");
    for (const field of node.replaceFields ?? []) {
      expect(field.known).toBe(false);
    }
  }
});

test("a rule targets the function, with the retry policy", async () => {
  let fn!: LambdaGroup;
  const graph = await collectResourceGraph(() => {
    fn = lambda({ id: "fulfil", code });
    rule({
      id: "order-placed",
      bus: defaultEventBus(),
      pattern,
      schema: Unknown,
      enabled: false,
      retry: { maxAttempts: 3 },
      target: fn,
    });
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
      schema: Unknown,
      target: fn,
    });
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
        schema: OrderPlaced,
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
      schema: OrderPlaced,
      target: () => fn,
    });
  });

  expect(permissionsOf(lambdaGroup(graph, "fulfil"))).toHaveLength(1);
});

test("rule() of a declaration whose schema is another object than the rule's throws", async () => {
  const Copy: typeof OrderPlaced = {
    "~standard": { ...OrderPlaced["~standard"] },
  };
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({ id: "fulfil", event: () => eventBridge.schema(OrderPlaced) }),
      );
      rule({
        id: "order-placed",
        bus: defaultEventBus(),
        pattern,
        schema: Copy,
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'rule() sends the events of the rule "order-placed" to the Lambda "fulfil", but the Lambda\'s event: () => eventBridge.schema(schema) has another schema than the rule. Give rule() and eventBridge.schema() the same schema, imported from a shared module.',
  );
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
        schema: OrderPlaced,
        // @ts-expect-error the declaration receives scheduled events
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    "event: () => eventBridge.schema(null) receives scheduled events, which have no detail.",
  );
});

test("rule() rejects a declaration whose schema type is not the rule's", () => {
  const refund = $lambda({
    id: "refund",
    event: () => eventBridge.schema(Refund),
  });
  const order = $lambda({
    id: "order",
    event: () => eventBridge.schema(OrderPlaced),
  });
  const bus = eventBus({ id: "orders" });

  // The calls are only type-checked.
  const typeOnly = () => {
    rule({
      id: "a",
      bus,
      pattern,
      schema: OrderPlaced,
      target: () => order,
    });
    rule({
      id: "b",
      bus,
      pattern,
      schema: OrderPlaced,
      // @ts-expect-error the declaration validates refunds, and the rule sends orders
      target: () => refund,
    });
  };
  void typeOnly;
});

test("a rule with an empty pattern throws", async () => {
  await expect(
    collectResourceGraph(() => {
      rule({
        id: "everything",
        bus: defaultEventBus(),
        pattern: {},
        schema: Unknown,
        target: lambda({ id: "fn", code }),
      });
    }),
  ).rejects.toThrow(
    'rule() with id "everything" needs a pattern that names at least one field',
  );
});

test("a rule whose AWS name is a schedule's throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "fn", code });
      schedule({ id: "daily", schedule: rate(1, "day"), target: fn });
      rule({
        id: "orders",
        name: "daily",
        bus: eventBus({ id: "orders" }),
        pattern,
        schema: Unknown,
        target: fn,
      });
    }),
  ).rejects.toThrow(
    'schedule({ id: "daily" }) and rule({ id: "orders", name: "daily" }) give two EventBridge rules the same AWS name',
  );
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

  expect(placed.rule.config.EventBusName).toBe(orders.busName);
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
        schema: OrderPlaced,
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
