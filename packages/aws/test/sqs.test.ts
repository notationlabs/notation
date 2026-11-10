import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, expectTypeOf, test } from "vitest";
import type { SQSRecord } from "aws-lambda";
import { lambda as awsLambda } from "src/resources";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import {
  collectResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import {
  $lambda,
  apiGateway,
  eventSourceMapping,
  lambda,
  sqs,
  type Lambda,
  type LambdaGroup,
  type SqsEvent,
} from "src/lambda";
import { resolveLambda } from "src/lambda/lambda-declaration";
import { queue } from "src/sqs";
import { inModule, lambdaGroup, Unknown } from "./declare";

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
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({
      source: orders,
      target: fn,
      batchSize: 5,
      maximumBatchingWindow: 2,
    });
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
    MaximumBatchingWindowInSeconds: 2,
  });
  expect(mapping.id).toBe("sqs-mapping:orders:process");
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
    refunds = queue({ id: "refunds", schema: Unknown });
    orders = queue({ id: "orders", schema: Unknown });
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
      const orders = queue({ id: "orders", schema: Unknown });
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
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({ source: orders, target: fn });
  });

  fn.role.setOutput({ Arn: "arn:role" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "process.zip",
    fileSha256: "sha",
  } as any);

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
  expect((await fn.fn.getParams()).Environment).toBeUndefined();
});

test("eventSourceMapping maps a queue to a declaration with sqs.schema(), whose decode() validates with the schema", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  let declaration!: Lambda<SqsEvent<typeof Order>>;
  const graph = await collectResourceGraph(() => {
    declaration = inModule(
      $lambda({ id: "process", event: () => sqs.schema(Order) }),
    );
    orders = queue({ id: "orders", schema: Order });
    eventSourceMapping({ source: orders, target: () => declaration });
  });
  const fn = lambdaGroup(graph, "process");

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
  expect(mappingOf(orders).getDependencies()).toContain(fn.policy);
  const { body: decoded } = await declaration.decode({
    body: '{"orderId":"a"}',
  } as SQSRecord);
  expectTypeOf(decoded).toEqualTypeOf<{ orderId: string }>();
  expect(decoded).toEqual({ orderId: "a" });
  await expect(declaration.decode({ body: "{}" } as any)).rejects.toThrow(
    "orderId must be a string",
  );
});

test("eventSourceMapping of a queue whose schema is not the declaration's throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const orders = queue({ id: "orders", schema: Order });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.schema(Refund) }),
      );
      eventSourceMapping({
        source: orders,
        // @ts-expect-error the declaration validates refunds, and the queue holds orders
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    `eventSourceMapping() maps the queue "orders" to the Lambda "process", but the Lambda's event: () => sqs.schema(schema) has another schema than the queue.`,
  );
});

test("eventSourceMapping of a queue whose schema is another object than the declaration's throws", async () => {
  const Copy: typeof Order = { "~standard": { ...Order["~standard"] } };
  await expect(
    collectResourceGraph(() => {
      const orders = queue({ id: "orders", schema: Copy });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.schema(Order) }),
      );
      eventSourceMapping({ source: orders, target: () => fn });
    }),
  ).rejects.toThrow(
    `eventSourceMapping() maps the queue "orders" to the Lambda "process", but the Lambda's event: () => sqs.schema(schema) has another schema than the queue. Give queue() and sqs.schema() the same schema, imported from a shared module.`,
  );
});

test("eventSourceMapping rejects a declaration whose schema type is not the queue's", () => {
  const refund = $lambda({ id: "refund", event: () => sqs.schema(Refund) });
  const order = $lambda({ id: "order", event: () => sqs.schema(Order) });
  const orders = queue({ id: "orders", schema: Order });

  // The calls are only type-checked.
  const typeOnly = () => {
    eventSourceMapping({ source: orders, target: () => order });
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
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({ source: orders, target: () => fn });
  });

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
});

test("eventSourceMapping of a declaration that a later module declares waits for evaluation to end", async () => {
  let fn!: Lambda<SqsEvent<typeof Order>>;
  let orders!: ReturnType<typeof queue<typeof Order>>;
  await collectResourceGraph(() => {
    orders = queue({ id: "orders", schema: Order });
    eventSourceMapping({ source: orders, target: () => fn });
    fn = inModule($lambda({ id: "process", event: () => sqs.schema(Order) }));
  });

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
});

test("eventSourceMapping of a declaration with an apiGateway event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({ id: "api", event: () => apiGateway.schema(null) }),
      );
      eventSourceMapping({
        source: queue({ id: "orders", schema: Unknown }),
        // @ts-expect-error a queue can't feed a function of HTTP requests
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'eventSourceMapping() sends sqs events, but the Lambda "api" is declared with event: () => apiGateway.schema(body).',
  );
});

test("eventSourceMapping of a function that returns no declaration throws", async () => {
  await expect(
    collectResourceGraph(() => {
      eventSourceMapping({
        source: queue({ id: "orders", schema: Unknown }),
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
      const other = queue({ id: "other", schema: Unknown });
      eventSourceMapping({
        source: queue({ id: "orders", schema: Unknown }),
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
    orders = queue({ id: "orders", schema: Unknown });
    fn.policy;
  });

  expect(() => eventSourceMapping({ source: orders, target: fn })).toThrow(
    "evaluation has ended",
  );
});

test("a queue whose AWS name is another queue's throws, and names both declarations", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({ id: "orders", schema: Unknown });
      queue({ id: "sales", name: "orders", schema: Unknown });
    }),
  ).rejects.toThrow(
    'queue({ id: "orders" }) and queue({ id: "sales", name: "orders" }) give two SQS queues the same AWS name, "orders".',
  );
});

test("a FIFO queue and a standard queue can share a name", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({ id: "orders", schema: Unknown });
      queue({ id: "sales", name: "orders", fifo: true, schema: Unknown });
    }),
  ).resolves.toBeDefined();
});

test("a queue with a dead-letter queue depends on it and sets its redrive policy", async () => {
  let orders!: ReturnType<typeof queue>;
  let dlq!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    dlq = queue({ id: "orders-dlq", schema: Unknown });
    orders = queue({
      id: "orders",
      schema: Unknown,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });
  });
  deploy(dlq);

  expect(orders.queue.getDependencies()).toContain(dlq.queue);
  expect((await orders.queue.getParams()).RedrivePolicy).toEqual({
    deadLetterTargetArn: queueArn("orders-dlq"),
    maxReceiveCount: 3,
  });
});

test("a FIFO queue with a standard dead-letter queue throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const dlq = queue({ id: "ledger-dlq", schema: Unknown });
      queue({
        id: "ledger",
        fifo: true,
        schema: Unknown,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });
    }),
  ).rejects.toThrow(
    'queue() "ledger" is a FIFO queue, but its dead-letter queue "ledger-dlq" is a standard queue.',
  );
});

test("a dead-letter queue given as an ARN sets the redrive policy with no dependency", async () => {
  const dlqArn = "arn:aws:sqs:eu-west-2:123456789012:shared-dlq";
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    orders = queue({
      id: "orders",
      schema: Unknown,
      deadLetterQueue: { queue: dlqArn, maxReceiveCount: 3 },
    });
  });

  expect(orders.queue.getDependencies()).toEqual([]);
  expect((await orders.queue.getParams()).RedrivePolicy).toEqual({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount: 3,
  });
});

test("a FIFO queue accepts the ARN of a FIFO dead-letter queue", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({
        id: "ledger",
        fifo: true,
        schema: Unknown,
        deadLetterQueue: {
          queue:
            "arn:aws-us-gov:sqs:us-gov-west-1:123456789012:ledger-dlq.fifo",
          maxReceiveCount: 3,
        },
      });
    }),
  ).resolves.toBeDefined();
});

test("a FIFO queue with the ARN of a standard dead-letter queue throws", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({
        id: "ledger",
        fifo: true,
        schema: Unknown,
        deadLetterQueue: {
          queue: "arn:aws:sqs:eu-west-2:123456789012:ledger-dlq",
          maxReceiveCount: 3,
        },
      });
    }),
  ).rejects.toThrow(
    'queue() "ledger" is a FIFO queue, but its dead-letter queue arn:aws:sqs:eu-west-2:123456789012:ledger-dlq is a standard queue.',
  );
});

test("a standard queue with the ARN of a FIFO dead-letter queue throws", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({
        id: "orders",
        schema: Unknown,
        deadLetterQueue: {
          queue: "arn:aws:sqs:eu-west-2:123456789012:orders-dlq.fifo",
          maxReceiveCount: 3,
        },
      });
    }),
  ).rejects.toThrow("is a standard queue, but its dead-letter queue");
});

test("a dead-letter queue given as the arn of a queue from queue() sets the redrive policy", async () => {
  let orders!: ReturnType<typeof queue>;
  let dlq!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    dlq = queue({ id: "orders-dlq", schema: Unknown });
    orders = queue({
      id: "orders",
      schema: Unknown,
      deadLetterQueue: { queue: dlq.arn, maxReceiveCount: 3 },
    });
  });
  deploy(dlq);

  expect(orders.queue.getDependencies()).toContain(dlq.queue);
  expect((await orders.queue.getParams()).RedrivePolicy).toEqual({
    deadLetterTargetArn: queueArn("orders-dlq"),
    maxReceiveCount: 3,
  });
});

test("a standard queue with a FIFO option throws", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({ id: "orders", schema: Unknown, contentBasedDeduplication: true });
    }),
  ).rejects.toThrow(
    'queue() "orders" sets contentBasedDeduplication, which only a FIFO queue has.',
  );
});

test("a per-message-group throughput limit without per-message-group deduplication throws", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({
        id: "ledger",
        fifo: true,
        schema: Unknown,
        fifoThroughputLimit: "perMessageGroupId",
      });
    }),
  ).rejects.toThrow(
    'queue() "ledger" sets fifoThroughputLimit: "perMessageGroupId", which SQS allows only with deduplicationScope: "messageGroup".',
  );
});

test("a FIFO queue passes its FIFO options and message size to the queue", async () => {
  let ledger!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    ledger = queue({
      id: "ledger",
      fifo: true,
      schema: Unknown,
      maximumMessageSize: 2_048,
      contentBasedDeduplication: true,
      deduplicationScope: "messageGroup",
      fifoThroughputLimit: "perMessageGroupId",
    });
  });

  expect(await ledger.queue.getParams()).toMatchObject({
    QueueName: expect.stringMatching(/ledger\.fifo$/),
    FifoQueue: true,
    MaximumMessageSize: 2_048,
    ContentBasedDeduplication: true,
    DeduplicationScope: "messageGroup",
    FifoThroughputLimit: "perMessageGroupId",
  });
});

test("the mapping options set the response types, scaling config and state", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({
      source: orders,
      target: fn,
      reportBatchItemFailures: true,
      maximumConcurrency: 5,
      enabled: false,
    });
  });
  deploy(orders);
  fn.fn.setOutput({ FunctionName: "process" } as any);

  expect(await mappingOf(orders).getParams()).toMatchObject({
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    ScalingConfig: { MaximumConcurrency: 5 },
    Enabled: false,
  });
});

test("a mapping without the options leaves them unset", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({ source: orders, target: fn });
  });
  deploy(orders);
  fn.fn.setOutput({ FunctionName: "process" } as any);

  const params = await mappingOf(orders).getParams();
  expect(params.FunctionResponseTypes).toBeUndefined();
  expect(params.ScalingConfig).toBeUndefined();
  expect(params.Enabled).toBeUndefined();
});

test("a batchSize over 10 without maximumBatchingWindow throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", code });
      const orders = queue({ id: "orders", schema: Unknown });
      eventSourceMapping({ source: orders, target: fn, batchSize: 20 });
    }),
  ).rejects.toThrow(
    'The mapping of the queue "orders" to the Lambda "process" sets batchSize: 20 without maximumBatchingWindow.',
  );
});

test("a batchSize over 10 with maximumBatchingWindow sets both", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ id: "orders", schema: Unknown });
    eventSourceMapping({
      source: orders,
      target: fn,
      batchSize: 100,
      maximumBatchingWindow: 5,
    });
  });
  deploy(orders);
  fn.fn.setOutput({ FunctionName: "process" } as any);

  expect(await mappingOf(orders).getParams()).toMatchObject({
    BatchSize: 100,
    MaximumBatchingWindowInSeconds: 5,
  });
});

test("a batchSize over 10 on a FIFO queue throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", code });
      const ledger = queue({ id: "ledger", fifo: true, schema: Unknown });
      eventSourceMapping({ source: ledger, target: fn, batchSize: 20 });
    }),
  ).rejects.toThrow(
    'sets batchSize: 20, but Lambda allows at most 10 for a FIFO queue.',
  );
});

test("a batching window on a FIFO queue throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", code });
      const ledger = queue({ id: "ledger", fifo: true, schema: Unknown });
      eventSourceMapping({
        source: ledger,
        target: fn,
        maximumBatchingWindow: 5,
      });
    }),
  ).rejects.toThrow(
    "sets maximumBatchingWindow: 5, but Lambda doesn't support a batching window for a FIFO queue.",
  );
});

test("grant allows the actions on the queue", () => {
  const orders = queue({ id: "orders", schema: Unknown });
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
    eventSourceMapping({
      source: queue({ id: "orders", schema: Unknown }),
      target: fn,
    });
  });

  const plan = await createPlan({
    resources: graph.resources,
    state: new MemoryStateBackend({}),
  });
  await rm(directory, { recursive: true, force: true });

  const order = plan.nodes.map((node) => node.id);
  const mapping = order.indexOf("sqs-mapping:orders:process");
  expect(order.indexOf("sqs-queue:orders")).toBeLessThan(mapping);
  expect(order.indexOf("lambda:process:role-policy")).toBeLessThan(mapping);
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
    eventSourceMapping({
      source: queue({ id: "orders", schema: Order }),
      target: () => fn,
    });
  });
  expect(lambdaGroup(graph, "process").id).toBe("process");
});

test("sqs.bind(queue) in a declaration maps the queue to the function", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  const graph = await collectResourceGraph(() => {
    orders = queue({ id: "orders", schema: Order });
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

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
  expect(await mappingOf(orders).getParams()).toMatchObject({
    EventSourceArn: queueArn("orders"),
    BatchSize: 5,
  });
  expect((await fn.policy.getParams()).PolicyDocument.Statement).toEqual([
    readStatement("orders"),
  ]);
});

test("a declaration whose queue fails to map throws the same error on each build", () => {
  let calls = 0;
  const failing = {
    schema: Unknown,
    "~subscribe"() {
      calls++;
      throw new Error("mapping failed");
    },
  };
  const fn = inModule(
    $lambda({ id: "process", event: () => sqs.bind(failing) }),
  );
  const { build } = (fn as any)[Symbol.for("@notation/aws/LambdaDeclaration")];

  expect(build).toThrow("mapping failed");
  expect(build).toThrow("mapping failed");
  expect(calls).toBe(1);
});

test("resolveLambda doesn't wire a declaration that makes its own queue mapping", () => {
  let calls = 0;
  const subscribing = {
    schema: Unknown,
    "~subscribe"() {
      calls++;
    },
  };
  const fn = inModule(
    $lambda({ id: "process", event: () => sqs.bind(subscribing) }),
  );
  expect(() => resolveLambda(() => fn, "test", "sqs")).toThrow(
    "makes its own queue mapping",
  );
  expect(calls).toBe(0);
});

test("sqs.bind(queue) can name a queue that a later module declares", async () => {
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    inModule($lambda({ id: "process", event: () => sqs.bind(orders) }));
    orders = queue({ id: "orders", schema: Unknown });
  });

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
});

test("decode() validates a message with the queue's schema", async () => {
  const orders = queue({ id: "orders", schema: Order });
  const fn = $lambda({ id: "process", event: () => sqs.bind(orders) });
  const { body: decoded } = await fn.decode({
    body: '{"orderId":"a"}',
  } as SQSRecord);

  expectTypeOf(decoded).toEqualTypeOf<{ orderId: string }>();
  expect(decoded).toEqual({ orderId: "a" });
  await expect(fn.decode({ body: "{}" } as any)).rejects.toThrow(
    "orderId must be a string",
  );
});

test("decode() with a schema that takes any value returns the parsed JSON", async () => {
  const anything = queue({ id: "anything", schema: Unknown });
  const fn = $lambda({ id: "process", event: () => sqs.bind(anything) });
  const { body: decoded } = await fn.decode({
    body: '{"orderId":"a","items":[1,2]}',
  } as SQSRecord);

  expectTypeOf(decoded).toEqualTypeOf<unknown>();
  expect(decoded).toEqual({ orderId: "a", items: [1, 2] });
  await expect(fn.decode({ body: "not json" } as any)).rejects.toThrow(
    "The message body is not valid JSON.",
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
      const orders = queue({ id: "orders", schema: Unknown });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.bind(orders) }),
      );
      eventSourceMapping({ source: orders, target: () => fn });
    }),
  ).rejects.toThrow(
    `eventSourceMapping() can't wire the Lambda "process", because the Lambda makes its own queue mapping in its declaration, with event: () => sqs.bind(queue). Make the queue mapping in one place: remove the eventSourceMapping() call, or declare the Lambda with event: () => sqs.schema(schema).`,
  );
});

test("queue() takes the schema type explicitly", () => {
  const orders = queue<typeof Order>({ id: "orders", schema: Order });
  expectTypeOf(orders.schema).toEqualTypeOf<typeof Order>();

  // An explicit schema type leaves the id to the runtime check.
  expect(() => queue<typeof Order>({ id: "bad.id", schema: Order })).toThrow(
    'Invalid queue() id "bad.id"',
  );

  // @ts-expect-error dots are not name-safe
  expect(() => queue({ id: "bad.id", schema: Order })).toThrow();
  const id: string = "orders";
  // @ts-expect-error a plain string can't be checked
  queue({ id, schema: Order });
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
    orders = queue({ id: "orders", schema: Order });
    const fn = inModule($lambda({ id: "process" }));
    eventSourceMapping({ source: orders, target: () => fn });
  });

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
});

test("eventSourceMapping of a queue with a schema to a lambda group from lambda() maps the queue", async () => {
  let orders!: ReturnType<typeof queue<typeof Order>>;
  await collectResourceGraph(() => {
    const fn = lambda({ id: "process", code });
    orders = queue({ id: "orders", schema: Order });
    eventSourceMapping({ source: orders, target: fn });
  });

  expect(mappingOf(orders).id).toBe("sqs-mapping:orders:process");
});
