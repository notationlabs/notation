import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { api } from "src/api-gateway";
import { rate, schedule, ScheduleGroup } from "src/event-bridge";
import { lambda } from "src/lambda";
import { queue } from "src/sqs";
import { Unknown } from "./declare";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;
const scope = { app: "orders-app", stage: "prod" };

const collect = <T>(declare: () => T, collectScope = scope) => {
  let result!: T;
  return collectResourceGraph(
    () => {
      result = declare();
    },
    { scope: collectScope },
  ).then(() => result);
};

test("AWS names start with the app and stage", async () => {
  let fn!: ReturnType<typeof lambda>;
  let ordersApi!: ReturnType<typeof api>;
  let ordersQueue!: ReturnType<typeof queue>;
  const graph = await collectResourceGraph(
    () => {
      fn = lambda({ id: "get-orders", code });
      ordersApi = api({ id: "orders-api" });
      ordersQueue = queue({ id: "orders", schema: Unknown });
      schedule({ id: "nightly", schedule: rate(1, "day"), target: fn });
    },
    { scope },
  );
  const nightly = graph.resourceGroups.find(
    (g): g is ScheduleGroup => g instanceof ScheduleGroup,
  )!;
  const declared = {
    fn,
    api: ordersApi,
    queue: ordersQueue,
    schedule: nightly,
  };

  expect(declared.fn.fn.config.FunctionName).toBe(
    "orders-app--prod--get-orders",
  );
  expect(declared.fn.role.config.RoleName).toBe(
    "orders-app--prod--get-orders-role",
  );
  expect(declared.api.api.config.Name).toBe("orders-app--prod--orders-api");
  expect(declared.queue.queue.config.QueueName).toBe(
    "orders-app--prod--orders",
  );
  expect(declared.schedule.rule.config.Name).toBe("orders-app--prod--nightly");
});

test("resource ids do not change with the stage", async () => {
  const prod = await collect(() => lambda({ id: "get-orders", code }));
  const staging = await collect(() => lambda({ id: "get-orders", code }), {
    ...scope,
    stage: "staging",
  });

  expect(staging.resources.map((r) => r.id)).toEqual(
    prod.resources.map((r) => r.id),
  );
  expect(staging.fn.config.FunctionName).not.toBe(prod.fn.config.FunctionName);
});

test("a long function and role name is shortened to 64 characters", async () => {
  const id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const fn = await collect(() => lambda({ id, code }));

  expect(fn.fn.config.FunctionName).toHaveLength(64);
  expect(fn.fn.config.FunctionName).toMatch(
    /^orders-app--prod--x+-[0-9a-f]{8}$/,
  );
  expect(fn.role.config.RoleName).toHaveLength(64);
  expect(fn.role.config.RoleName).not.toBe(fn.fn.config.FunctionName);
});

test("the policy's role name is the scoped role name", async () => {
  const fn = await collect(() => {
    const fn = lambda({ id: "get-orders", code });
    fn.policy.contribute({
      PolicyDocument: {
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" },
        ],
      },
    });
    return fn;
  });

  expect(fn.policy.config.RoleName).toBe("orders-app--prod--get-orders-role");
  expect(fn.policy.config.PolicyName).toBe("get-orders-role-policy");
});

test("a FIFO queue's AWS name ends in .fifo", async () => {
  const declared = await collect(() =>
    queue({ id: "orders", fifo: true, schema: Unknown }),
  );

  expect(declared.queue.config.QueueName).toBe("orders-app--prod--orders.fifo");
});

test("a shortened FIFO queue name still ends in .fifo", async () => {
  const id = "q".repeat(64) as "q";
  const declared = await collect(() =>
    queue({ id, fifo: true, schema: Unknown }),
  );

  expect(declared.queue.config.QueueName).toHaveLength(80);
  expect(declared.queue.config.QueueName).toMatch(
    /^orders-app--prod--q+-[0-9a-f]{8}\.fifo$/,
  );
});

test("the id keys each resource in state and is the base of its AWS name", async () => {
  let fn!: ReturnType<typeof lambda>;
  let ordersApi!: ReturnType<typeof api>;
  let ordersQueue!: ReturnType<typeof queue>;
  const graph = await collectResourceGraph(
    () => {
      fn = lambda({ id: "get-orders", code });
      ordersApi = api({ id: "orders-api" });
      ordersQueue = queue({ id: "orders", schema: Unknown });
      schedule({ id: "nightly", schedule: rate(1, "day"), target: fn });
    },
    { scope },
  );
  const nightly = graph.resourceGroups.find(
    (g): g is ScheduleGroup => g instanceof ScheduleGroup,
  )!;

  expect(fn.id).toBe("get-orders");
  expect(fn.fn.id).toBe("lambda:get-orders");
  expect(ordersApi.id).toBe("orders-api");
  expect(ordersApi.api.id).toBe("api:orders-api");
  expect(ordersQueue.id).toBe("orders");
  expect(ordersQueue.queue.id).toBe("sqs-queue:orders");
  expect(nightly.id).toBe("nightly");
  expect(nightly.rule.id).toBe("eventbridge-rule:nightly");
});

test("name overrides the AWS name, with the app and stage, and the id stays the state key", async () => {
  let fn!: ReturnType<typeof lambda>;
  let ordersApi!: ReturnType<typeof api>;
  let ordersQueue!: ReturnType<typeof queue>;
  let fifoQueue!: ReturnType<typeof queue>;
  const graph = await collectResourceGraph(
    () => {
      fn = lambda({ id: "get-orders", name: "fetch-orders", code });
      ordersApi = api({ id: "orders-api", name: "shop-api" });
      ordersQueue = queue({
        id: "orders",
        name: "order-events",
        schema: Unknown,
      });
      fifoQueue = queue({
        id: "ledger",
        name: "ledger-events",
        fifo: true,
        schema: Unknown,
      });
      schedule({
        id: "nightly",
        name: "nightly-report",
        schedule: rate(1, "day"),
        target: fn,
      });
    },
    { scope },
  );
  const nightly = graph.resourceGroups.find(
    (g): g is ScheduleGroup => g instanceof ScheduleGroup,
  )!;

  expect(fn.fn.id).toBe("lambda:get-orders");
  expect(fn.fn.config.FunctionName).toBe("orders-app--prod--fetch-orders");
  expect(fn.role.config.RoleName).toBe("orders-app--prod--get-orders-role");
  expect(ordersApi.api.id).toBe("api:orders-api");
  expect(ordersApi.api.config.Name).toBe("orders-app--prod--shop-api");
  expect(ordersQueue.queue.id).toBe("sqs-queue:orders");
  expect(ordersQueue.queue.config.QueueName).toBe(
    "orders-app--prod--order-events",
  );
  expect(fifoQueue.queue.config.QueueName).toBe(
    "orders-app--prod--ledger-events.fifo",
  );
  expect(nightly.rule.id).toBe("eventbridge-rule:nightly");
  expect(nightly.rule.config.Name).toBe("orders-app--prod--nightly-report");
});

test("an id or a name that is not name-safe throws", () => {
  // @ts-expect-error dots are not name-safe
  expect(() => queue({ id: "orders.fifo", schema: Unknown })).toThrow(
    'Invalid queue() id "orders.fifo"',
  );
  // @ts-expect-error an id is required
  expect(() => api({})).toThrow("api() requires an id");
  expect(() =>
    queue({ id: "orders", name: "orders.fifo", schema: Unknown }),
  ).toThrow('Invalid queue() name "orders.fifo"');
  expect(() =>
    schedule({
      // @ts-expect-error spaces are not name-safe
      id: "every day",
      schedule: rate(1, "day"),
      target: lambda({ id: "fn", code }),
    }),
  ).toThrow('Invalid schedule() id "every day"');
});
