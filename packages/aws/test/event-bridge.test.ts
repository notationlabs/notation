import { test, expect } from "vitest";
import { eventBridge } from "@notation/aws.iac";
import { rate, schedule } from "src/event-bridge";
import { lambda, LambdaGroup } from "src/lambda";
import { runtimeRef } from "./runtime-ref";

const declareLambda = () =>
  lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });

test("each schedule on a lambda gets its own invoke permission", () => {
  const fn = declareLambda();
  const handler = runtimeRef(fn, "handler", "schedule");
  const daily = schedule({ name: "daily", schedule: rate(1, "day"), handler });
  const hourly = schedule({
    name: "hourly",
    schedule: rate(1, "hour"),
    handler,
  });

  const rules = fn.resources
    .filter((r) => r instanceof eventBridge.LambdaEventBridgeRulePermission)
    .map((r) => r.dependencies.eventBridgeRule);

  expect(rules).toEqual([daily.rule, hourly.rule]);
});

test("a schedule group is identified by its name", () => {
  const handler = runtimeRef(declareLambda(), "handler", "schedule");
  const daily = schedule({ name: "daily", schedule: rate(1, "day"), handler });

  expect(daily.id).toBe("daily");
  expect(daily.rule.group).toEqual({
    type: "aws/eventBridge/schedule",
    id: "daily",
  });
});

test("the rule's target names the export and passes on the original event", async () => {
  const fn = declareLambda();
  const daily = schedule({
    name: "daily",
    schedule: rate(1, "day"),
    handler: runtimeRef(fn, "sendDigest", "schedule"),
  });
  fn.fn.setOutput({
    FunctionName: "handler",
    FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
  } as any);

  expect((await daily.rule.getParams()).Targets).toEqual([
    {
      Id: "handler",
      Arn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
      InputTransformer: {
        InputTemplate:
          '{"export":"sendDigest","event":<aws.events.event.json>}',
      },
    },
  ]);
  expect(fn.fn.config.Environment).toBeUndefined();
});

test("the rule sends the bare event to a lambda group from lambda()", async () => {
  const fn = declareLambda();
  const daily = schedule({
    name: "daily",
    schedule: rate(1, "day"),
    handler: fn,
  });
  fn.fn.setOutput({
    FunctionName: "handler",
    FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
  } as any);

  expect((await daily.rule.getParams()).Targets).toEqual([
    {
      Id: "handler",
      Arn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
    },
  ]);
});

test("schedule rejects a value that is not a reference to a runtime export", () => {
  expect(() =>
    schedule({
      name: "daily",
      schedule: rate(1, "day"),
      handler: (async () => {}) as any,
    }),
  ).toThrow("schedule() expects a handler exported from a runtime module");
});

test("schedule takes a lambda group from another copy of the package", () => {
  const fn = declareLambda();
  // A copy of the class: the same members, but not the same prototype.
  const proto = Object.create(Object.getPrototypeOf(LambdaGroup.prototype));
  Object.defineProperties(
    proto,
    Object.getOwnPropertyDescriptors(LambdaGroup.prototype),
  );
  Object.setPrototypeOf(fn, proto);
  expect(fn).not.toBeInstanceOf(LambdaGroup);

  expect(() =>
    schedule({ name: "daily", schedule: rate(1, "day"), handler: fn }),
  ).not.toThrow();
});
