---
"@notation/aws": minor
---

EventBridge rules can now send the events on an event bus to a Lambda function, and `eventBridge.schema()` takes a schema for the event's detail.

```ts
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "infra/orders";
import { OrderPlaced } from "shared/schema";

export const lambda = $lambda({
  id: "fulfil-order",
  event: () =>
    eventBridge.bind(ordersBus).defineRule({
      id: "order-placed",
      pattern: { source: ["shop"], "detail-type": ["OrderPlaced"] },
      schema: OrderPlaced,
    }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { detail: order } = await lambda.decode(event);
};
```

- `eventBus({ id, name })` in `@notation/aws/event-bridge` declares a custom event bus, named `<app>--<stage>--<id>`. `defaultEventBus()` returns the account's default bus, which Notation reads and never changes or deletes. Each call returns the same bus. Both have the output refs `arn` and `name`, and `grant(["PutEvents"])`. In a function, the runtime build replaces a bus with `{}`. Changing a bus's `name` replaces the bus: deploy deletes the rules on it, replaces the bus, and creates the rules again. Other resources that depend on the bus, such as a function whose `env` holds the bus's name, are updated in place. This also works when the same deploy removes the last rule in code: deploy loads the class of the old rule from the provider package that its state record names.
- `eventBridge.bind(bus).defineRule({ id, name, pattern, schema, enabled, retry })` makes a rule on the bus that sends the events that match `pattern` to the function, and the permission that lets the rule invoke it. `rule({ id, name, pattern, enabled, retry, bus, target })` makes the same rule from infra, for a declaration with `eventBridge.schema(schema)`, a declaration with no event, or a Lambda group. `rule()` takes no schema, as the function's declaration names it. `rule()` throws for a declaration with `eventBridge.schema(null)`, and for a declaration that makes its own rule.
- `schema` is required in `defineRule()`. A rule whose events can have any detail declares a schema such as `v.unknown()`. A pattern with no fields throws.
- `enabled: false` disables the rule. `retry: { maxAttempts, maxEventAge }` sets the target's retry policy.
- No two EventBridge rules or schedules in a deployment can have the same AWS name, even on different buses.
- `eventBridge.schema(schema)` declares a function that receives the events of rules that infra makes. `eventBridge.schema(null)` still declares a function that receives scheduled events. `schedule()` throws for a declaration with a detail schema, and TypeScript rejects it.
- `decode(event)` validates the event's `detail` with the schema, and returns the event with `detail` typed as the schema's output. A `DecodeError` for the detail has the `part` `"detail"`. A function of scheduled events still has no `decode()`.
- `LambdaHandler<typeof lambda>` types the event of a rule as `EventBridgeEvent<string, unknown>`.
- `EventBridgeRuleEvent<S>` is the event type of `eventBridge`. `EventBridgeScheduleEvent` is now `EventBridgeRuleEvent<null>`, and has `schema: null`. `ScheduleConfig.target` is a `ScheduleTarget`, which is `RuleTarget<null>`.
- `@notation/aws/resources` adds `eventBridge.EventBus` and `eventBridge.DefaultEventBus`. `eventBridge.EventBridgeRule` takes a `State`, and an optional `eventBus` dependency, and blocks the delete of an `EventBus`. It sends and reads `EventPattern` in compact JSON, so a pattern that config holds in another layout is not reported as drift.
