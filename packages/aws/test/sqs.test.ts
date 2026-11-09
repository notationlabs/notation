import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, expectTypeOf, test } from "vitest";
import { lambda as awsLambda } from "@notation/aws.iac";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import {
  collectResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import {
  $lambda,
  eventSourceMapping,
  http,
  lambda,
  sqs,
  type Lambda,
  type LambdaGroup,
  type SqsEvent,
} from "src/lambda";
import { resolveLambda } from "src/lambda/lambda-declaration";
import { queue } from "src/sqs";
import { inModule, lambdaGroup } from "./declare";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

const Order: StandardSchemaV1<unknown, { orderId: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as any)?.orderId === "string"
        ? { value: value as { orderId: string } }
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

const mappingOf = (q: ReturnType<typeof queue>) =>
  q.resources.find(
    (r): r is awsLambda.LambdaEventSourceMappingInstance =>
      r instanceof awsLambda.LambdaEventSourceMapping,
  )!;

const queueArn = (name: string) => `arn:aws:sqs:eu-west-2:123456789012:${name}`;

const readStatement = (name: string) => ({
  Effect: "Allow",
  Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
  Resource: queueArn(name),
});

// Stands in for a deploy of the queues, so their output values have values.
function deploy(...queues: ReturnType<typeof queue>[]) {
  for (const q of queues) {
    q.queue.setOutput({
      QueueName: q.id,
      QueueUrl: `https://sqs.eu-west-2.amazonaws.com/123456789012/${q.id}`,
      QueueArn: queueArn(q.id),
    });
  }
}

test("eventSourceMapping grants the function access to the queue and maps the queue to it", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  let mapping!: awsLambda.LambdaEventSourceMappingInstance;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: orders, target: fn, batchSize: 5 });
  });
  mapping = mappingOf(orders);
  deploy(orders);
  fn.role.setOutput({ RoleName: "process-role" } as any);
  fn.fn.setOutput({ FunctionName: "process" } as any);

  expect((await fn.policy.getParams()).PolicyDocument).toEqual({
    Version: "2012-10-17",
    Statement: [readStatement("orders")],
  });
  expect(await mapping.getParams()).toMatchObject({
    EventSourceArn: queueArn("orders"),
    FunctionName: "process",
    BatchSize: 5,
  });
  expect(mapping.id).toBe("orders-process-mapping");
  expect(mapping.group).toEqual({ type: "aws/sqs/queue", id: "orders" });
  expect(mapping.getDependencies()).toEqual(
    expect.arrayContaining([fn.policy, fn.fn, orders.queue]),
  );
});

test("two queues feeding one function each add a statement", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  let refunds!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    refunds = queue({ name: "refunds" });
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: refunds, target: fn });
    eventSourceMapping({ source: orders, target: fn });
  });
  deploy(orders, refunds);
  fn.role.setOutput({ RoleName: "process-role" } as any);

  expect((await fn.policy.getParams()).PolicyDocument.Statement).toEqual([
    readStatement("orders"),
    readStatement("refunds"),
  ]);
});

test("a function that consumes nothing has no inline policy", async () => {
  const graph = await collectResourceGraph(() => {
    lambda({ id: "process", code });
  });

  expect(
    graph.resources.some((r) => r instanceof awsLambda.LambdaRolePolicy),
  ).toBe(false);
});

test("mapping one queue twice with one function throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", code });
      const orders = queue({ name: "orders" });
      eventSourceMapping({ source: orders, target: fn });
      eventSourceMapping({ source: orders, target: fn });
    }),
  ).rejects.toThrow("Queue orders already feeds process");
});

test("eventSourceMapping with a lambda group from lambda() sets no environment", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: orders, target: fn });
  });

  fn.role.setOutput({ Arn: "arn:role" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "process.zip",
    fileSha256: "sha",
  } as any);

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
  expect((await fn.fn.getParams()).Environment).toBeUndefined();
});

test("eventSourceMapping maps a queue to a declaration with sqs.schema(), whose decode() validates with the schema", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  let declaration!: Lambda<SqsEvent<typeof Order>>;
  const graph = await collectResourceGraph(() => {
    declaration = inModule(
      $lambda({ id: "process", event: () => sqs.schema(Order) }),
    );
    orders = queue({ name: "orders", schema: Order });
    eventSourceMapping({ source: orders, target: () => declaration });
  });
  const fn = lambdaGroup(graph, "process");

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
  expect(mappingOf(orders).getDependencies()).toContain(fn.policy);
  const decoded = await declaration.decode({ body: '{"orderId":"a"}' } as any);
  expectTypeOf(decoded).toEqualTypeOf<{ orderId: string }>();
  expect(decoded).toEqual({ orderId: "a" });
  await expect(declaration.decode({ body: "{}" } as any)).rejects.toThrow(
    "orderId must be a string",
  );
});

test("eventSourceMapping maps a queue with no schema to a declaration with sqs.schema()", async () => {
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    const fn = inModule(
      $lambda({ id: "process", event: () => sqs.schema(Order) }),
    );
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: orders, target: () => fn });
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("eventSourceMapping of a queue whose schema is another object than the declaration's throws", async () => {
  const Copy: typeof Order = { "~standard": { ...Order["~standard"] } };
  await expect(
    collectResourceGraph(() => {
      const orders = queue({ name: "orders", schema: Copy });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.schema(Order) }),
      );
      eventSourceMapping({ source: orders, target: () => fn });
    }),
  ).rejects.toThrow(
    `eventSourceMapping() maps the queue "orders" to the Lambda "process", but the queue's schema is not the schema of the Lambda's event: () => sqs.schema(schema), so the function would validate the queue's messages with another schema. Give queue() and sqs.schema() the same schema, imported from a shared module.`,
  );
});

test("eventSourceMapping rejects a declaration whose schema type is not the queue's", () => {
  const refund = $lambda({ id: "refund", event: () => sqs.schema(Refund) });
  const order = $lambda({ id: "order", event: () => sqs.schema(Order) });
  const orders = queue({ name: "orders", schema: Order });
  const untyped = queue({ name: "untyped" });

  // The calls are only type-checked.
  const typeOnly = () => {
    eventSourceMapping({ source: orders, target: () => order });
    eventSourceMapping({ source: untyped, target: () => refund });
    eventSourceMapping({
      source: orders,
      // @ts-expect-error the declaration validates refunds, and the queue holds orders
      target: () => refund,
    });
  };
  void typeOnly;
});

test("eventSourceMapping takes a declaration with no event", async () => {
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    const fn = inModule($lambda({ id: "process" }));
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: orders, target: () => fn });
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("eventSourceMapping of a declaration that a later module declares waits for evaluation to end", async () => {
  let fn!: Lambda<SqsEvent<typeof Order>>;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    orders = queue({ name: "orders" });
    eventSourceMapping({ source: orders, target: () => fn });
    fn = inModule($lambda({ id: "process", event: () => sqs.schema(Order) }));
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("eventSourceMapping of a declaration with an http event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule($lambda({ id: "api", event: () => http() }));
      eventSourceMapping({
        source: queue({ name: "orders" }),
        // @ts-expect-error a queue can't feed a function of HTTP requests
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'eventSourceMapping() sends sqs events, but the Lambda "api" is declared with event: () => http().',
  );
});

test("eventSourceMapping of a function that returns no declaration throws", async () => {
  await expect(
    collectResourceGraph(() => {
      eventSourceMapping({
        source: queue({ name: "orders" }),
        target: (() => undefined) as any,
      });
    }),
  ).rejects.toThrow(
    "eventSourceMapping() expects a function that returns a Lambda declaration from $lambda(), but it returned undefined.",
  );
});

test("eventSourceMapping of a function that returns another resource throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const other = queue({ name: "other" });
      eventSourceMapping({
        source: queue({ name: "orders" }),
        // @ts-expect-error a queue is not a Lambda declaration
        target: () => other,
      });
    }),
  ).rejects.toThrow(
    "eventSourceMapping() expects a function that returns a Lambda declaration from $lambda(), but it returned another value.",
  );
});

test("eventSourceMapping after evaluation has ended throws", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    fn.policy;
  });

  expect(() => eventSourceMapping({ source: orders, target: fn })).toThrow(
    "evaluation has ended",
  );
});

test("grant allows the actions on the queue", () => {
  const orders = queue({ name: "orders" });
  deploy(orders);

  expect(orders.grant(["SendMessage"])).toEqual({
    Effect: "Allow",
    Action: ["sqs:SendMessage"],
    Resource: orders.arn,
  });
});

test("a plan creates the queue and the policy before the mapping", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "notation-sqs-"));
  const zipPath = path.join(directory, "handler.zip");
  await writeFile(zipPath, "zip bytes");
  const graph = await collectResourceGraph(() => {
    const fn = lambda({
      id: "process",
      code: { type: "zip", path: zipPath },
    });
    eventSourceMapping({ source: queue({ name: "orders" }), target: fn });
  });

  const plan = await createPlan({
    resources: graph.resources,
    state: new MemoryStateBackend({}),
  });
  await rm(directory, { recursive: true, force: true });

  const order = plan.nodes.map((node) => node.id);
  const mapping = order.indexOf("orders-process-mapping");
  expect(order.indexOf("orders-queue")).toBeLessThan(mapping);
  expect(order.indexOf("process-role-policy")).toBeLessThan(mapping);
  expect(order.indexOf("process")).toBeLessThan(mapping);
  expect(plan.nodes.every((node) => node.decision === "create")).toBe(true);
});

test("eventSourceMapping accepts a declaration from another copy of the package", async () => {
  // A second instance of the module that declares $lambda, with its own
  // module state.
  const other: typeof import("src/lambda/lambda-declaration") = await import(
    // @ts-expect-error the query string makes a second instance
    "src/lambda/lambda-declaration?copy"
  );
  expect(other.$lambda).not.toBe($lambda);
  const graph = await collectResourceGraph(() => {
    const fn = inModule(
      other.$lambda({ id: "process", event: () => sqs.schema(Order) }),
    );
    eventSourceMapping({ source: queue({ name: "orders" }), target: () => fn });
  });
  expect(lambdaGroup(graph, "process").id).toBe("process");
});

test("sqs.bind(queue) in a declaration maps the queue to the function", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  const graph = await collectResourceGraph(() => {
    orders = queue({ name: "orders", schema: Order });
    inModule(
      $lambda({
        id: "process",
        event: () => sqs.bind(orders, { batchSize: 5 }),
      }),
    );
  });
  const fn = lambdaGroup(graph, "process");
  deploy(orders);
  fn.role.setOutput({ RoleName: "process-role" } as any);
  fn.fn.setOutput({ FunctionName: "process" } as any);

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
  expect(await mappingOf(orders).getParams()).toMatchObject({
    EventSourceArn: queueArn("orders"),
    BatchSize: 5,
  });
  expect((await fn.policy.getParams()).PolicyDocument.Statement).toEqual([
    readStatement("orders"),
  ]);
});

test("a declaration whose queue fails to map builds one group", () => {
  let calls = 0;
  const failing = {
    schema: undefined,
    "~subscribe"() {
      calls++;
      throw new Error("mapping failed");
    },
  };
  const fn = inModule(
    $lambda({ id: "process", event: () => sqs.bind(failing) }),
  );
  const build = () => resolveLambda(() => fn, "test", ["sqs"]);

  expect(build).toThrow("mapping failed");
  const group = build();
  expect(build()).toBe(group);
  expect(calls).toBe(1);
});

test("sqs.bind(queue) can name a queue that a later module declares", async () => {
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    inModule($lambda({ id: "process", event: () => sqs.bind(orders) }));
    orders = queue({ name: "orders" });
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("decode() validates a message with the queue's schema", async () => {
  const orders = queue({ name: "orders", schema: Order });
  const fn = $lambda({ id: "process", event: () => sqs.bind(orders) });
  const decoded = await fn.decode({ body: '{"orderId":"a"}' } as any);

  expectTypeOf(decoded).toEqualTypeOf<{ orderId: string }>();
  expect(decoded).toEqual({ orderId: "a" });
  await expect(fn.decode({ body: "{}" } as any)).rejects.toThrow(
    "orderId must be a string",
  );
});

test("decode() reads the schema from the object that the runtime build passes", async () => {
  const fn = $lambda({
    id: "process",
    // The runtime build replaces the queue with its runtime options.
    event: () => sqs.bind({ schema: Order } as any),
  });

  await expect(fn.decode({ body: "{}" } as any)).rejects.toThrow(
    "orderId must be a string",
  );
});

test("eventSourceMapping of a declaration that maps a queue itself throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const orders = queue({ name: "orders" });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.bind(orders) }),
      );
      eventSourceMapping({ source: orders, target: () => fn });
    }),
  ).rejects.toThrow(
    `eventSourceMapping() maps the queue "orders" to the Lambda "process", which maps the same queue in its declaration, with event: () => sqs.bind(queue). Map the queue in one place: remove the eventSourceMapping() call, or declare the Lambda with event: () => sqs.schema(schema).`,
  );
});

test("sqs.bind() rejects a schema in place of a queue", () => {
  // @ts-expect-error a schema is not a queue
  sqs.bind(Order);
});

test("sqs is not callable", () => {
  // @ts-expect-error sqs is an object, with bind() and schema()
  expect(() => sqs(Order)).toThrow(TypeError);
});

test("eventSourceMapping of a queue with a schema to a declaration with no event maps the queue", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  await collectResourceGraph(() => {
    orders = queue({ name: "orders", schema: Order });
    const fn = inModule($lambda({ id: "process" }));
    eventSourceMapping({ source: orders, target: () => fn });
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("eventSourceMapping of a queue with a schema to a lambda group from lambda() maps the queue", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  await collectResourceGraph(() => {
    const fn = lambda({ id: "process", code });
    orders = queue({ name: "orders", schema: Order });
    eventSourceMapping({ source: orders, target: fn });
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});
