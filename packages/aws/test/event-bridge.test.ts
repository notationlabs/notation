import { test, expect } from "vitest";
import { eventBridge } from "@notation/aws.iac";
import { rate, schedule } from "src/event-bridge";
import { lambda } from "src/lambda";

test("each schedule on a lambda gets its own invoke permission", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
    handler: "handler.fn.js",
  });
  const daily = schedule({ name: "daily", schedule: rate(1, "day"), handler });
  const hourly = schedule({
    name: "hourly",
    schedule: rate(1, "hour"),
    handler,
  });

  const rules = handler.resources
    .filter((r) => r instanceof eventBridge.LambdaEventBridgeRulePermission)
    .map((r) => r.dependencies.eventBridgeRule);

  expect(rules).toEqual([daily.rule, hourly.rule]);
});
