import { test, expect } from "vitest";
import { eventBridge } from "@notation/aws.iac";
import { collectResourceGraph, type ResourceGraph } from "@notation/resource";
import { rate, schedule, ScheduleGroup } from "src/event-bridge";
import { createLambda, lambda, LambdaGroup, scheduled, sqs } from "src/lambda";
import { inModule, lambdaGroup } from "./declare";

const declareLambda = () =>
  lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });

const scheduleGroup = (graph: ResourceGraph, name: string) =>
  graph.resourceGroups.find(
    (g): g is ScheduleGroup => g instanceof ScheduleGroup && g.id === name,
  )!;

test("each schedule on a lambda gets its own invoke permission", async () => {
  let fn!: LambdaGroup;
  const graph = await collectResourceGraph(() => {
    fn = declareLambda();
    schedule({ name: "daily", schedule: rate(1, "day"), target: fn });
    schedule({ name: "hourly", schedule: rate(1, "hour"), target: fn });
  });

  const rules = fn.resources
    .filter((r) => r instanceof eventBridge.LambdaEventBridgeRulePermission)
    .map((r) => r.dependencies.eventBridgeRule);

  expect(rules).toEqual([
    scheduleGroup(graph, "daily").rule,
    scheduleGroup(graph, "hourly").rule,
  ]);
});

test("a schedule group is identified by its name", async () => {
  const graph = await collectResourceGraph(() => {
    schedule({
      name: "daily",
      schedule: rate(1, "day"),
      target: declareLambda(),
    });
  });
  const daily = scheduleGroup(graph, "daily");

  expect(daily.id).toBe("daily");
  expect(daily.rule.group).toEqual({
    type: "aws/eventBridge/schedule",
    id: "daily",
  });
});

test("the rule sends the bare event to the function", async () => {
  let fn!: LambdaGroup;
  const graph = await collectResourceGraph(() => {
    fn = declareLambda();
    schedule({ name: "daily", schedule: rate(1, "day"), target: fn });
  });
  fn.fn.setOutput({
    FunctionName: "handler",
    FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
  } as any);

  expect(
    (await scheduleGroup(graph, "daily").rule.getParams()).Targets,
  ).toEqual([
    {
      Id: "handler",
      Arn: "arn:aws:lambda:eu-west-2:123456789012:function:handler",
    },
  ]);
  expect(fn.fn.config.Environment).toBeUndefined();
});

test("a schedule invokes a createLambda declaration", async () => {
  const graph = await collectResourceGraph(() => {
    const fn = inModule(
      createLambda({ id: "digest", event: () => scheduled() }),
    );
    schedule({ name: "daily", schedule: rate(1, "day"), target: () => fn });
  });
  const fn = lambdaGroup(graph, "digest");

  expect(scheduleGroup(graph, "daily").rule.dependencies.lambda).toBe(fn.fn);
});

test("a schedule of a declaration with an sqs event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(createLambda({ id: "process", event: () => sqs() }));
      schedule({
        name: "daily",
        schedule: rate(1, "day"),
        // @ts-expect-error a schedule can't invoke a function of SQS messages
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'schedule() sends scheduled events, but the Lambda "process" is declared with event: () => sqs().',
  );
});

test("schedule rejects a value that is not a declaration or a lambda group", () => {
  expect(() =>
    schedule({
      name: "daily",
      schedule: rate(1, "day"),
      target: {} as any,
    }),
  ).toThrow("schedule() expects a function that returns a Lambda declaration");
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
    schedule({ name: "daily", schedule: rate(1, "day"), target: fn }),
  ).not.toThrow();
});
