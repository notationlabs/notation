import { test, expect } from "vitest";
import {
  collectResourceGraph,
  generatedPhysicalName,
} from "@notation/resource";
import { api } from "src/api-gateway";
import {
  eventBus,
  rate,
  rule,
  schedule,
  ScheduleGroup,
} from "src/event-bridge";
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

test("a declaration with only an id passes no AWS name", async () => {
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

  // Deploy generates each name.
  expect(declared.fn.fn.config.FunctionName).toBeUndefined();
  expect(declared.fn.role.config.RoleName).toBeUndefined();
  expect(declared.api.api.config.Name).toBeUndefined();
  expect(declared.queue.queue.config.QueueName).toBeUndefined();
  expect(declared.schedule.rule.config.Name).toBeUndefined();
});

test("resource ids do not change with the stage", async () => {
  const declare = () =>
    lambda({ id: "get-orders", name: "fetch-orders", code });
  const prod = await collect(declare);
  const staging = await collect(declare, { ...scope, stage: "staging" });

  expect(staging.resources.map((r) => r.id)).toEqual(
    prod.resources.map((r) => r.id),
  );
  expect(staging.fn.config.FunctionName).not.toBe(prod.fn.config.FunctionName);
});

test("a long function name is shortened to 64 characters", async () => {
  const name = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const fn = await collect(() => lambda({ id: "get-orders", name, code }));

  expect(fn.fn.config.FunctionName).toHaveLength(64);
  expect(fn.fn.config.FunctionName).toMatch(
    /^orders-app--prod--x+-[0-9a-f]{8}$/,
  );
});

test("the policy's role name is the role's RoleName output", async () => {
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

  fn.role.setOutput({ RoleName: "orders-app--prod--role-1a2b3c4d" } as any);
  expect(await fn.policy.getParams()).toMatchObject({
    RoleName: "orders-app--prod--role-1a2b3c4d",
  });
  expect(fn.policy.config.PolicyName).toBe("get-orders-role-policy");
});

test("a named FIFO queue's AWS name ends in .fifo", async () => {
  const declared = await collect(() =>
    queue({ id: "orders", name: "sales", fifo: true, schema: Unknown }),
  );

  expect(declared.queue.config.QueueName).toBe("orders-app--prod--sales.fifo");
});

test("the name that deploy generates for a queue ends in .fifo only for a FIFO queue", async () => {
  const generate = async (fifo: boolean) => {
    const { queue: resource } = await collect(() =>
      queue({ id: "orders", fifo, schema: Unknown }),
    );
    const item = resource.schema.QueueName!;
    if (item.propertyType !== "param" || !item.physicalName) {
      throw new Error("QueueName has no physicalName rule");
    }
    return generatedPhysicalName(
      scope,
      resource.id,
      "1a2b3c4d",
      item.physicalName,
      await resource.getParams(),
    );
  };

  expect(await generate(true)).toBe("orders-app--prod--orders-1a2b3c4d.fifo");
  expect(await generate(false)).toBe("orders-app--prod--orders-1a2b3c4d");
});

test("a generated AWS name leaves out the type prefix of the resource id", async () => {
  const graph = await collectResourceGraph(
    () => {
      const fn = lambda({ id: "orders", code });
      const bus = eventBus({ id: "orders" });
      queue({ id: "orders", schema: Unknown });
      queue({ id: "ledger", fifo: true, schema: Unknown });
      api({ id: "orders" });
      rule({
        id: "orders",
        bus,
        pattern: { source: ["shop.orders"] },
        target: fn,
      });
      schedule({ id: "orders", schedule: rate(1, "day"), target: fn });
    },
    { scope: { app: "shop", stage: "prod" } },
  );

  const names: Record<string, string> = {};
  for (const resource of graph.resources) {
    for (const item of Object.values(resource.schema)) {
      if (item.propertyType !== "param" || !item.physicalName) continue;
      names[resource.id] = generatedPhysicalName(
        { app: "shop", stage: "prod" },
        resource.id,
        "1a2b3c4d",
        item.physicalName,
        resource.config,
      );
    }
  }

  expect(names).toEqual({
    "lambda:orders": "shop--prod--orders-1a2b3c4d",
    "lambda:orders:role": "shop--prod--orders-role-1a2b3c4d",
    "sqs-queue:orders": "shop--prod--orders-1a2b3c4d",
    "sqs-queue:ledger": "shop--prod--ledger-1a2b3c4d.fifo",
    "api:orders": "shop--prod--orders-1a2b3c4d",
    "eventbridge-bus:orders": "shop--prod--orders-1a2b3c4d",
    "eventbridge-pattern-rule:orders": "shop--prod--orders-1a2b3c4d",
    "eventbridge-rule:orders": "shop--prod--orders-1a2b3c4d",
  });
});

test("a shortened FIFO queue name still ends in .fifo", async () => {
  const name = "q".repeat(64);
  const declared = await collect(() =>
    queue({ id: "orders", name, fifo: true, schema: Unknown }),
  );

  expect(declared.queue.config.QueueName).toHaveLength(80);
  expect(declared.queue.config.QueueName).toMatch(
    /^orders-app--prod--q+-[0-9a-f]{8}\.fifo$/,
  );
});

test("the id keys each resource in state", async () => {
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
