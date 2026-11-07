import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { lambda as awsLambda } from "@notation/aws.iac";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { collectResourceGraph } from "@notation/resource";
import {
  createLambda,
  http,
  lambda,
  sqs,
  type Lambda,
  type LambdaGroup,
  type SqsEvent,
} from "src/lambda";
import { queue } from "src/sqs";
import { inModule, lambdaGroup } from "./declare";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

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

test("consume grants the function access to the queue and maps the queue to it", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  let mapping!: awsLambda.LambdaEventSourceMappingInstance;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    orders.consume(fn, { batchSize: 5 });
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
    refunds.consume(fn);
    orders.consume(fn);
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

test("consuming one queue twice with one function throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", code });
      const orders = queue({ name: "orders" });
      orders.consume(fn);
      orders.consume(fn);
    }),
  ).rejects.toThrow("Queue orders already feeds process");
});

test("consume with a lambda group from lambda() sets no environment", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    orders.consume(fn);
  });

  fn.role.setOutput({ Arn: "arn:role" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "process.zip",
    fileSha256: "sha",
  } as any);

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
  expect((await fn.fn.getParams()).Environment).toBeUndefined();
});

test("consume maps the queue to a createLambda declaration", async () => {
  let orders!: ReturnType<typeof queue>;
  const graph = await collectResourceGraph(() => {
    const fn = inModule(createLambda({ id: "process", event: () => sqs() }));
    orders = queue({ name: "orders" });
    orders.consume(() => fn);
  });
  const fn = lambdaGroup(graph, "process");

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
  expect(mappingOf(orders).getDependencies()).toContain(fn.policy);
});

test("consume takes a declaration with no event", async () => {
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    const fn = inModule(createLambda({ id: "process" }));
    orders = queue({ name: "orders" });
    orders.consume(() => fn);
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("consume of a declaration that a later module declares waits for evaluation to end", async () => {
  let fn!: Lambda<SqsEvent<undefined>>;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    orders = queue({ name: "orders" });
    orders.consume(() => fn);
    fn = inModule(createLambda({ id: "process", event: () => sqs() }));
  });

  expect(mappingOf(orders).id).toBe("orders-process-mapping");
});

test("consume of a declaration with an http event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(createLambda({ id: "api", event: () => http() }));
      // @ts-expect-error a queue can't feed a function of HTTP requests
      queue({ name: "orders" }).consume(() => fn);
    }),
  ).rejects.toThrow(
    'queue.consume() sends sqs events, but the Lambda "api" is declared with event: () => http().',
  );
});

test("consume of a function that returns no declaration throws", async () => {
  await expect(
    collectResourceGraph(() => {
      queue({ name: "orders" }).consume((() => undefined) as any);
    }),
  ).rejects.toThrow(
    "queue.consume() expects a function that returns a Lambda declaration from createLambda(), but it returned undefined.",
  );
});

test("consume of a function that returns another resource throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const other = queue({ name: "other" });
      // @ts-expect-error a queue is not a Lambda declaration
      queue({ name: "orders" }).consume(() => other);
    }),
  ).rejects.toThrow(
    "queue.consume() expects a function that returns a Lambda declaration from createLambda(), but it returned another value.",
  );
});

test("consume after evaluation has ended throws", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", code });
    orders = queue({ name: "orders" });
    fn.policy;
  });

  expect(() => orders.consume(fn)).toThrow("evaluation has ended");
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
    queue({ name: "orders" }).consume(fn);
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
