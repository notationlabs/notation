import { test, expect } from "vitest";
import {
  collectResourceGraph,
  generatedPhysicalName,
  type BaseResource,
} from "@notation/resource";
import { api } from "src/api-gateway";
import {
  eventBus,
  rate,
  rule,
  RuleGroup,
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

// The name that deploy generates for the resource, with the instance
// 1a2b3c4d.
const generatedName = (resource: BaseResource, nameScope = scope) => {
  const [item] = Object.values(resource.schema).filter(
    (item) => item.propertyType === "param" && item.physicalName,
  );
  if (item?.propertyType !== "param" || !item.physicalName) {
    throw new Error(`${resource.id} has no physicalName param`);
  }
  return generatedPhysicalName(
    nameScope,
    resource.id,
    "1a2b3c4d",
    item.physicalName,
    resource.config,
  );
};

test("a declaration passes no AWS name", async () => {
  let fn!: ReturnType<typeof lambda>;
  let ordersApi!: ReturnType<typeof api>;
  let ordersQueue!: ReturnType<typeof queue>;
  let ordersBus!: ReturnType<typeof eventBus>;
  const graph = await collectResourceGraph(
    () => {
      fn = lambda({ id: "get-orders", code });
      ordersApi = api({ id: "orders-api" });
      ordersQueue = queue({ id: "orders", schema: Unknown });
      ordersBus = eventBus({ id: "orders" });
      rule({
        id: "order-placed",
        bus: ordersBus,
        pattern: { source: ["shop.orders"] },
        target: fn,
      });
      schedule({ id: "nightly", schedule: rate(1, "day"), target: fn });
    },
    { scope },
  );
  const nightly = graph.resourceGroups.find(
    (g): g is ScheduleGroup => g instanceof ScheduleGroup,
  )!;
  const orderPlaced = graph.resourceGroups.find(
    (g): g is RuleGroup => g instanceof RuleGroup,
  )!;
  const declared = {
    fn,
    api: ordersApi,
    queue: ordersQueue,
    bus: ordersBus,
    rule: orderPlaced,
    schedule: nightly,
  };

  // Deploy generates each name.
  expect(declared.fn.fn.config).not.toHaveProperty("FunctionName");
  expect(declared.fn.role.config).not.toHaveProperty("RoleName");
  expect(declared.api.api.config).not.toHaveProperty("Name");
  expect(declared.queue.queue.config).not.toHaveProperty("QueueName");
  expect(declared.bus.bus.config).not.toHaveProperty("Name");
  expect(declared.rule.rule.config).not.toHaveProperty("Name");
  expect(declared.schedule.rule.config).not.toHaveProperty("Name");
});

test("resource ids do not change with the stage", async () => {
  const declare = () => lambda({ id: "get-orders", code });
  const prod = await collect(declare);
  const staging = await collect(declare, { ...scope, stage: "staging" });

  expect(staging.resources.map((r) => r.id)).toEqual(
    prod.resources.map((r) => r.id),
  );
  expect(generatedName(staging.fn, { ...scope, stage: "staging" })).not.toBe(
    generatedName(prod.fn),
  );
});

test("a generated function name from a long id is cut to 64 characters", async () => {
  const id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const fn = await collect(() => lambda({ id, code }));
  const name = generatedName(fn.fn);

  expect(name).toHaveLength(64);
  expect(name).toMatch(/^orders-app--prod--x+-1a2b3c4d$/);
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

test("the name that deploy generates for a queue ends in .fifo only for a FIFO queue", async () => {
  const generate = async (fifo: boolean) => {
    const declared = await collect(() =>
      queue({ id: "orders", fifo, schema: Unknown }),
    );
    return generatedName(declared.queue);
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

test("a generated FIFO queue name that is cut short still ends in .fifo", async () => {
  const id = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const declared = await collect(() =>
    queue({ id, fifo: true, schema: Unknown }),
  );
  const name = generatedName(declared.queue);

  expect(name).toHaveLength(80);
  expect(name).toMatch(/^orders-app--prod--q+-1a2b3c4d\.fifo$/);
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

test("an id that is not name-safe throws", () => {
  // @ts-expect-error dots are not name-safe
  expect(() => queue({ id: "orders.fifo", schema: Unknown })).toThrow(
    'Invalid queue() id "orders.fifo"',
  );
  // @ts-expect-error an id is required
  expect(() => api({})).toThrow("api() requires an id");
  expect(() =>
    schedule({
      // @ts-expect-error spaces are not name-safe
      id: "every day",
      schedule: rate(1, "day"),
      target: lambda({ id: "fn", code }),
    }),
  ).toThrow('Invalid schedule() id "every day"');
});
