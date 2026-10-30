import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { api } from "src/api-gateway";
import { rate, schedule } from "src/event-bridge";
import { lambda } from "src/lambda";
import { queue } from "src/sqs";

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
  const declared = await collect(() => {
    const fn = lambda({ id: "get-orders", handler: "handler", code });
    return {
      fn,
      api: api({ name: "orders-api" }),
      queue: queue({ name: "orders" }),
      schedule: schedule({
        name: "nightly",
        schedule: rate(1, "day"),
        handler: fn,
      }),
    };
  });

  expect(declared.fn.fn.config.FunctionName).toBe("orders-app-prod-get-orders");
  expect(declared.fn.role.config.RoleName).toBe(
    "orders-app-prod-get-orders-role",
  );
  expect(declared.api.api.config.Name).toBe("orders-app-prod-orders-api");
  expect(declared.queue.queue.config.QueueName).toBe("orders-app-prod-orders");
  expect(declared.schedule.rule.config.Name).toBe("orders-app-prod-nightly");
});

test("resource ids do not change with the stage", async () => {
  const prod = await collect(() =>
    lambda({ id: "get-orders", handler: "handler", code }),
  );
  const staging = await collect(
    () => lambda({ id: "get-orders", handler: "handler", code }),
    { ...scope, stage: "staging" },
  );

  expect(staging.resources.map((r) => r.id)).toEqual(
    prod.resources.map((r) => r.id),
  );
  expect(staging.fn.config.FunctionName).not.toBe(prod.fn.config.FunctionName);
});

test("a long function and role name is shortened to 64 characters", async () => {
  const id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const fn = await collect(() => lambda({ id, handler: "handler", code }));

  expect(fn.fn.config.FunctionName).toHaveLength(64);
  expect(fn.fn.config.FunctionName).toMatch(/^orders-app-prod-x+-[0-9a-f]{8}$/);
  expect(fn.role.config.RoleName).toHaveLength(64);
  expect(fn.role.config.RoleName).not.toBe(fn.fn.config.FunctionName);
});

test("the policy's role name is the scoped role name", async () => {
  const fn = await collect(() => {
    const fn = lambda({ id: "get-orders", handler: "handler", code });
    fn.policy.contribute({
      PolicyDocument: {
        Statement: [
          { Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" },
        ],
      },
    });
    return fn;
  });

  expect(fn.policy.config.RoleName).toBe("orders-app-prod-get-orders-role");
  expect(fn.policy.config.PolicyName).toBe("get-orders-role-policy");
});

test("a shortened FIFO queue name still ends in .fifo", async () => {
  const name = `${"q".repeat(70)}.fifo`;
  const declared = await collect(() => queue({ name, fifo: true }));

  expect(declared.queue.config.QueueName).toHaveLength(80);
  expect(declared.queue.config.QueueName).toMatch(
    /^orders-app-prod-q+-[0-9a-f]{8}\.fifo$/,
  );
});
