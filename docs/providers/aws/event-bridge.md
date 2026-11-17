# Amazon EventBridge

Route application and AWS service events with EventBridge buses and pattern-matching rules, and invoke Lambda handlers on recurring schedules with automatically scoped permissions.

For AWS credential and region setup, see [AWS Overview](./overview.md).

Install `@aws-sdk/client-eventbridge` if your publishers send events from Lambda:

```sh [Terminal]
@pm.add("@aws-sdk/client-eventbridge")
```

Wire a custom event bus, a publisher Lambda that sends `OrderPlaced` events, and a consumer Lambda that matches those events with a pattern rule:

::code-group

```ts [shared/schema.ts]
import * as v from "valibot";

export const OrderPlaced = v.object({
  orderId: v.string(),
  total: v.number(),
});
```

```ts [infra/orders.ts]
import { eventBus } from "@notation/aws/event-bridge";

export const ordersBus = eventBus({ id: "orders" });
```

```ts [runtime/create-order.ts]
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { $lambda, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "../infra/orders";

const client = new EventBridgeClient();

export const lambda = $lambda({
  id: "create-order",
  env: () => ({ ORDERS_BUS_NAME: ordersBus.name }),
  policy: () => [ordersBus.grant(["PutEvents"])],
});

export const handler: LambdaHandler<typeof lambda> = async () => {
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: lambda.env().ORDERS_BUS_NAME,
          Source: "shop",
          DetailType: "OrderPlaced",
          Detail: JSON.stringify({ orderId: "ord_123", total: 149.5 }),
        },
      ],
    }),
  );
};
```

```ts [runtime/fulfil-order.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "../infra/orders";
import { OrderPlaced } from "../shared/schema";

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
  console.log("fulfil", order.orderId, order.total);
};
```

::

`ordersBus.name` and `ordersBus.arn` are deploy-time output refs (see [Outputs & Contributions](../../core/outputs-and-contributions.md)), and `eventBridge.bind(ordersBus).defineRule()` provisions the rule and invoke permission automatically.

## Content filtering

Filter events by envelope fields and nested `detail` conditions using `EventPattern`:

```ts [infra/orders.ts]
import { rule, type EventPattern } from "@notation/aws/event-bridge";
import { ordersBus } from "./orders";
import { lambda as highValueOrder } from "../runtime/high-value-order";

const highValuePattern: EventPattern = {
  source: ["shop"],
  "detail-type": ["OrderPlaced"],
  detail: {
    orderId: [{ prefix: "ord_" }],
    total: [{ numeric: [">=", 100] }],
    channel: [{ "anything-but": "test" }],
  },
};

rule({
  id: "high-value-orders",
  bus: ordersBus,
  pattern: highValuePattern,
  target: () => highValueOrder,
});
```

Every specified field must match (AND), and at least one item in each field's array must match (OR). Empty patterns (`{}`) throw at declaration time.

## Infra-owned rules

Use `eventBridge.schema()` in a runtime module with `rule()` in `infra/` to attach multiple rules to one Lambda, target a `lambda()` group, or keep runtime modules free of `infra/` imports:

::code-group

```ts [shared/schema.ts]
import * as v from "valibot";

export const OrderShipped = v.object({
  orderId: v.string(),
  carrier: v.string(),
});
```

```ts [runtime/record-shipment.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { OrderShipped } from "../shared/schema";

export const lambda = $lambda({
  id: "record-shipment",
  event: () => eventBridge.schema(OrderShipped),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { detail: shipment } = await lambda.decode(event);
  console.log("shipped", shipment.orderId, shipment.carrier);
};
```

```ts [infra/orders.ts]
import { eventBus, rule } from "@notation/aws/event-bridge";
import { lambda as recordShipment } from "../runtime/record-shipment";

export const ordersBus = eventBus({ id: "orders" });

rule({
  id: "order-shipped",
  bus: ordersBus,
  pattern: { source: ["shop"], "detail-type": ["OrderShipped"] },
  target: () => recordShipment,
});
```

::

Set `enabled: false` on `rule()` or `defineRule()` to keep the rule provisioned in AWS with `State: "DISABLED"` so it pauses matching events.

## Scheduled rules

Run a Lambda on a recurring `rate()` or UTC `cron()` schedule either inside `$lambda` with `eventBridge.defineSchedule()` or centrally with `schedule()`:

::code-group

```ts [runtime/nightly-digest.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { rate } from "@notation/aws/event-bridge";

export const lambda = $lambda({
  id: "nightly-digest",
  event: () => eventBridge.defineSchedule({ id: "nightly-digest", schedule: rate(1, "day") }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("digest for", event.time);
};
```

```ts [runtime/weekday-report.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "weekday-report",
  event: () => eventBridge.schema(null),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("report at", event.time);
};
```

```ts [infra/schedule.ts]
import { cron, schedule } from "@notation/aws/event-bridge";
import { lambda as weekdayReport } from "../runtime/weekday-report";

schedule({
  id: "weekday-report",
  schedule: cron("0 9 ? * MON-FRI *"),
  target: () => weekdayReport,
});
```

::

Scheduled rules run on the account's `"default"` event bus. Because scheduled events have no application `detail` schema, `lambda.decode` is typed as `never` and throws at runtime.

## Default event bus

Call `defaultEventBus()` to subscribe rules to AWS service events on the account's built-in `"default"` event bus without modifying or deleting the bus:

```ts [infra/orders.ts]
import { defaultEventBus } from "@notation/aws/event-bridge";

export const accountBus = defaultEventBus();
```

Repeated calls to `defaultEventBus()` return the same singleton `DefaultEventBusGroup`.

## Invalid event details

For pattern rules, `await lambda.decode(event)` validates `event.detail` directly (without JSON parsing) and throws `DecodeError` (`part: "detail"`) on schema mismatches:

```ts [runtime/fulfil-order.ts]
import { $lambda, DecodeError, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "../infra/orders";
import { OrderPlaced } from "../shared/schema";

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
  try {
    const { detail: order } = await lambda.decode(event);
    console.log("fulfil", order.orderId, order.total);
  } catch (error) {
    if (error instanceof DecodeError && error.part === "detail") {
      console.error("invalid event detail", error.issues);
      return;
    }
    throw error;
  }
};
```

## Reference

### Bus options

`@notation/aws/event-bridge` exports two bus constructors returning subclasses of `EventBus`: `eventBus({ id })` declares a custom `EventBusGroup` (`id` is `1` to `64` name-safe characters matching `[A-Za-z0-9_-]`; changing `id` replaces the bus), and `defaultEventBus()` returns the singleton `DefaultEventBusGroup` reading the account's `"default"` event bus.

Both expose these properties and helpers:

| Property | Description |
| :--- | :--- |
| `arn` | `OutputRef<string>` resolving to the event bus ARN |
| `name` | `OutputRef<string>` resolving to the event bus name |
| `bus` | Underlying `@notation/aws/resources` `EventBus` or `DefaultEventBus` resource |
| `grant(actions)` | Returns an IAM `Allow` `PolicyStatement` for `events:<action>` on `bus.arn` |

`EventBusAction` accepts `"PutEvents"`.

### Rule options

`rule(config)` and `eventBridge.bind(bus).defineRule(options)` share these options:

| Option | Description |
| :--- | :--- |
| `id` | Required `NameSafe<Id>` string identifying the rule |
| `bus` | Required `EventBus` from `eventBus()` or `defaultEventBus()` on `rule()` |
| `pattern` | Required non-empty `EventPattern` |
| `target` | Required `RuleTarget` thunk or `LambdaGroup` on `rule()` |
| `schema` | Required `StandardSchemaV1` validator for `event.detail` on `defineRule()` |
| `enabled` | Optional `boolean` controlling rule state; defaults to `true` |
| `retry` | Optional `RetryOptions` for failed deliveries to the target Lambda |

`id` must be `1` to `64` name-safe characters, and `target` accepts a `() => lambda` thunk or a `LambdaGroup`. Pass `v.unknown()` to `schema` for arbitrary payloads, and set `enabled: false` to provision the rule in `"DISABLED"` state. `rule()` rejects self-bound `$lambda` targets, scheduled targets (`eventBridge.schema(null)`), and targets declared for other event sources.

### Event pattern structure

`EventPattern` matches envelope fields and nested `detail` properties (`DetailPattern`):

| Field | Description |
| :--- | :--- |
| Envelope fields | `id`, `version`, `time`, `source`, `"detail-type"`, `account`, `region`, and `resources` |
| Detail fields | Nested `detail` object mapping field names to `PatternMatcher[]` or nested `DetailPattern` objects |
| Matchers | `string \| number \| boolean \| null` or content filters such as `{ prefix }`, `{ "anything-but" }`, and `{ numeric }` |

### Retry policy

`RetryOptions` accepts `maxAttempts` (whole number from `0` to `185`, defaulting to `185`) and `maxEventAge` (whole number of seconds from `60` to `86_400`, defaulting to `86_400`). Values outside these integer bounds throw before deployment.

### Schedule options

`schedule(config)` and `eventBridge.defineSchedule(options)` accept:

| Option | Description |
| :--- | :--- |
| `id` | Required `NameSafe<Id>` string keying the rule in state |
| `schedule` | Required `Schedule` built with `rate(value, unit)` or `cron(cronExpression)` |
| `target` | Required `ScheduleTarget` thunk or `LambdaGroup` on `schedule()` |

`id` must be `1` to `64` name-safe characters, and `target` accepts a `() => lambda` thunk or a `LambdaGroup`. `rate(value, unit)` builds `rate(<value> <unit>)` where `unit` (`RateUnit`) is `"minute" | "minutes" | "hour" | "hours" | "day" | "days"` (singular for `1`, plural for `> 1`), and `cron(cronExpression)` builds `cron(<cronExpression>)` using EventBridge's 6-field UTC syntax (`minutes hours day-of-month month day-of-week year`). `schedule()` rejects `$lambda` targets with a detail schema (`eventBridge.schema(schema)`), self-defined schedules or rules, and targets declared for other event sources.

### Handler types

`@notation/aws/lambda` supports both `$lambda`-derived and standalone EventBridge handler types:

| Type | Description |
| :--- | :--- |
| `LambdaHandler<typeof lambda>` | Derives `EventBridgeEvent` and `void \| Promise<void>` from `$lambda` |
| `EventBridgeHandler<TypeDescription, DetailType>` | Standalone rule handler type for `lambda()` |
| `EventBridgeScheduleHandler` | Alias for `EventBridgeHandler<"Scheduled Event", any>` |

`LambdaHandler<typeof lambda>` types `event` as `EventBridgeEvent<string, unknown>` for rules or `EventBridgeEvent<"Scheduled Event", unknown>` for schedules.

### Physical naming

Custom buses generate stage-scoped physical names up to `256` characters, and rules up to `64` characters per bus (see [Physical Names](../../core/physical-names.md)).
