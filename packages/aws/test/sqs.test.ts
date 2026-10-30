import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { lambda as awsLambda } from "@notation/aws.iac";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { collectResourceGraph } from "@notation/resource";
import { lambda, type LambdaGroup } from "src/lambda";
import { queue } from "src/sqs";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

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
    fn = lambda({ id: "process", handler: "processOrders", code });
    orders = queue({ name: "orders" });
    mapping = orders.consume(fn, { batchSize: 5 });
  });
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
    fn = lambda({ id: "process", handler: "processOrders", code });
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
    lambda({ id: "process", handler: "processOrders", code });
  });

  expect(
    graph.resources.some((r) => r instanceof awsLambda.LambdaRolePolicy),
  ).toBe(false);
});

test("consuming one queue twice with one function throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = lambda({ id: "process", handler: "processOrders", code });
      const orders = queue({ name: "orders" });
      orders.consume(fn);
      orders.consume(fn);
    }),
  ).rejects.toThrow("Queue orders already feeds process");
});

test("consume after evaluation has ended throws", async () => {
  let fn!: LambdaGroup;
  let orders!: ReturnType<typeof queue>;
  await collectResourceGraph(() => {
    fn = lambda({ id: "process", handler: "processOrders", code });
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
      handler: "processOrders",
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
