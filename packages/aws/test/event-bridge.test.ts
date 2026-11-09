import { test, expect } from "vitest";
import { eventBridge as iac } from "@notation/aws.iac";
import {
  collectResourceGraph,
  type ResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import { rate, schedule, ScheduleGroup } from "src/event-bridge";
import { $lambda, eventBridge, lambda, LambdaGroup, sqs } from "src/lambda";
import * as runtime from "src/lambda/runtime";
import { inModule, lambdaGroup } from "./declare";

const Anything: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
};

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
    .filter((r) => r instanceof iac.LambdaEventBridgeRulePermission)
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

test("a schedule invokes a $lambda declaration", async () => {
  const graph = await collectResourceGraph(() => {
    const fn = inModule(
      $lambda({ id: "digest", event: () => eventBridge.schedule() }),
    );
    schedule({ name: "daily", schedule: rate(1, "day"), target: () => fn });
  });
  const fn = lambdaGroup(graph, "digest");

  expect(scheduleGroup(graph, "daily").rule.dependencies.lambda).toBe(fn.fn);
});

test("a schedule of a declaration with an sqs event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.schema(Anything) }),
      );
      schedule({
        name: "daily",
        schedule: rate(1, "day"),
        // @ts-expect-error a schedule can't invoke a function of SQS messages
        target: () => fn,
      });
    }),
  ).rejects.toThrow(
    'schedule() sends eventBridge events, but the Lambda "process" is declared with event: () => sqs.schema(schema).',
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

test("eventBridge.defineSchedule() in a declaration makes the rule and the permission", async () => {
  const graph = await collectResourceGraph(() => {
    inModule(
      $lambda({
        id: "digest",
        event: () =>
          eventBridge.defineSchedule({
            name: "nightly",
            schedule: rate(1, "day"),
          }),
      }),
    );
  });
  const fn = lambdaGroup(graph, "digest");
  const nightly = scheduleGroup(graph, "nightly");

  expect(nightly.rule.config.ScheduleExpression).toBe("rate(1 day)");
  expect(nightly.rule.dependencies.lambda).toBe(fn.fn);
  expect(
    fn.resources
      .filter((r) => r instanceof iac.LambdaEventBridgeRulePermission)
      .map((r) => r.dependencies.eventBridgeRule),
  ).toEqual([nightly.rule]);
});

test("schedule() of a declaration that makes its own schedule throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule(
        $lambda({
          id: "digest",
          event: () =>
            eventBridge.defineSchedule({
              name: "nightly",
              schedule: rate(1, "day"),
            }),
        }),
      );
      schedule({ name: "daily", schedule: rate(1, "day"), target: () => fn });
    }),
  ).rejects.toThrow(
    'schedule() invokes the Lambda "digest" on the schedule "daily", but the Lambda makes its own schedule in its declaration, with event: () => eventBridge.defineSchedule(options). Schedule the Lambda in one place: remove the schedule() call, or declare the Lambda with event: () => eventBridge.schedule().',
  );
});

test("eventBridge.defineSchedule() takes undefined, as the runtime build passes", () => {
  expect(runtime.eventBridge.defineSchedule(undefined as any)).toEqual({
    kind: "eventBridge",
    schedule: undefined,
  });
});

test("eventBridge.defineSchedule() needs a name and a schedule", () => {
  // Only type-checked.
  const typeOnly = () => {
    // @ts-expect-error the schedule is missing
    eventBridge.defineSchedule({ name: "nightly" });
  };
  void typeOnly;
});
