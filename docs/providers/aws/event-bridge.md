# EventBridge

`@notation/aws/event-bridge` creates event buses, rules that send the events on a bus to a Lambda function, and schedules that invoke a Lambda function. A function receives the events of a rule in one of two ways:

| Function-led                                              | Infra-led                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `event: () => eventBridge.bind(bus).defineRule(options)`  | `event: () => eventBridge.schema(OrderShipped)`              |
| The declaration makes the rule.                           | Infra makes rules with `rule({ id, bus, pattern, target })`. |
| `decode()` validates the detail with the `schema` option. | `decode()` validates the detail with `OrderShipped`.         |

A function receives the events of a schedule in the same two ways:

| Function-led                                                | Infra-led                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `event: () => eventBridge.defineSchedule({ id, schedule })` | `event: () => eventBridge.schema(null)`                          |
| The declaration makes the schedule.                         | Infra makes schedules with `schedule({ id, schedule, target })`. |

`eventBridge` comes from `@notation/aws/lambda`. `eventBus()`, `defaultEventBus()`, `rule()`, `schedule()`, `rate()`, `cron()` and `once()` come from `@notation/aws/event-bridge`.

## `eventBus(config)`

```ts [infra/orders.ts]
import { eventBus } from "@notation/aws/event-bridge";

export const ordersBus = eventBus({ id: "orders" });
```

### Config

```ts [@notation/aws/event-bridge]
type EventBusConfig = {
  id: string;
  name?: string;
};
```

`id` keys the bus in state, so changing it replaces the bus. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. In AWS, the bus is named `<app>--<stage>--<id>`, such as `my-app--prod--orders`.

`name` replaces the `id` in the AWS name, so `eventBus({ id: "orders", name: "shop" })` is named `my-app--prod--shop`. Changing `name` also replaces the bus. AWS does not delete a bus that has rules, so the deploy first deletes the rules on the bus. Then it deletes the bus, creates the new bus, and creates the rules again. Until they exist again, events sent to the bus do not reach their functions. Other resources that depend on the bus stay in place, and the deploy updates them with the new bus's outputs. A function whose `env` holds the bus's `arn` or `name` is updated, and a role policy with a `grant()` of the bus is updated too. The new rules have new ARNs, so the deploy replaces the Lambda permission of each rule. See [AWS names](../../manual/project-config.md#aws-names).

This also works when the same deploy removes the last EventBridge rule in your code. Notation loads the class of the old rule from the provider package that its state record names, so it knows to delete the rule before the bus.

A bus has no schema. One bus carries events of many types, and each function declares the schema of the events that it receives.

### `arn` and `name`

`ordersBus.arn` and `ordersBus.name` are output values: they don't exist until AWS creates the bus, but you can place them in another resource's config now. Notation makes that resource depend on the bus and fills in the real value at deploy. See [Output values](../../reference/resource.md#output-values).

An output value can only be placed whole. Turning it into a string, for example in a template string, throws.

### `bus.grant(actions)`

`grant` returns a policy statement for the bus. A declaration adds it to its function's role with the `policy` option. For example, to let the `checkout` function send events to `ordersBus`:

```ts [runtime/checkout.ts]
import { $lambda } from "@notation/aws/lambda";
import { ordersBus } from "infra/orders";

export const lambda = $lambda({
  id: "checkout",
  policy: () => [ordersBus.grant(["PutEvents"])],
  env: () => ({ ORDERS_BUS_NAME: ordersBus.name }),
});
```

The function sends events with `PutEventsCommand` from `@aws-sdk/client-eventbridge`, and names the bus in each entry's `EventBusName`. Nothing checks that the detail of an event that a sender writes matches a schema.

```ts [@notation/aws/event-bridge]
type EventBusAction = "PutEvents";
```

## `defaultEventBus()`

`defaultEventBus()` returns the account's default event bus. AWS makes the default bus, and AWS services, such as S3 or EC2, send their events to it. It has `arn`, `name` and `grant()`, as a bus from `eventBus()` has.

```ts [infra/buses.ts]
import { defaultEventBus } from "@notation/aws/event-bridge";

export const defaultBus = defaultEventBus();
```

Each call returns the same bus. Notation reads the bus to get its ARN, and never changes or deletes it.

## `eventBridge.bind(bus).defineRule(options)`

A declaration names the bus and the events that its function receives in `event`:

::code-group

```ts [runtime/fulfil-order.ts]
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
  console.log(order.orderId);
};
```

```ts [infra/orders.ts]
import { eventBus } from "@notation/aws/event-bridge";

export const ordersBus = eventBus({ id: "orders" });
```

::

The infra module only declares the bus. When infra has finished loading, the declaration makes two things:

1. **An EventBridge rule** on `ordersBus`, `order-placed`, which sends the events that match `pattern` to the function.
2. **A Lambda permission** that lets the rule invoke the function.

`eventBridge.bind(bus)` returns an object with one method, `defineRule()`. To make a rule on the default bus, declare it in an infra module, such as `export const defaultBus = defaultEventBus()`, and bind `defaultBus`. A call to `defaultEventBus()` in the declaration fails the runtime build, as any call to a resource function does.

### Options

```ts [@notation/aws/lambda]
type RuleOptions = {
  id: string;
  name?: string;
  pattern: EventPattern;
  enabled?: boolean;
  retry?: RetryOptions;
};

// The options of defineRule()
type DefineRuleOptions = RuleOptions & {
  schema: StandardSchemaV1;
};

type RetryOptions = {
  maxAttempts?: number;
  maxEventAge?: number;
};
```

`id` keys the rule in state, so changing it replaces the rule. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. In AWS, the rule is named `<app>--<stage>--<id>`, such as `my-app--prod--order-placed`. `name` replaces the `id` in the rule's AWS name. Changing `name` also replaces the rule.

AWS lets two buses have rules with the same name, but Notation doesn't: in one deployment, no two rules or schedules can have the same AWS name.

`pattern` is the [event pattern](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html) that the rule matches. Each field holds a list of values, and the field matches when the event's field has one of them. A value can also be a content filter, such as `{ prefix: "order-" }` or `{ numeric: [">", 100] }`. `detail` holds a pattern for the event's detail, field by field:

```ts
pattern: {
  source: ["shop"],
  "detail-type": ["OrderPlaced"],
  detail: { currency: ["GBP", "EUR"], total: [{ numeric: [">", 100] }] },
}
```

A pattern with no fields throws when infra runs. Notation sends the pattern to AWS as JSON, and AWS checks the rest of it at deploy.

`schema` is a [Standard Schema](https://standardschema.dev) for the detail of each event. `decode()` validates the detail with it; see [Validating events](#validating-events).

**`defineRule()` needs a schema.** A rule whose events can have any detail declares a schema that accepts any value, such as valibot's `v.unknown()`.

`enabled: false` disables the rule, so it sends no events. The rule stays in AWS. When you remove `enabled`, the next deploy enables the rule again.

`retry` sets how EventBridge retries an event that it fails to deliver to the function, for example when Lambda throttles the invocation. `maxAttempts` is the number of retries, from 0 to 185. `maxEventAge` is the number of seconds that EventBridge keeps retrying an event, from 60 to 86,400. Notation sets a field that you leave out to EventBridge's default: 185 attempts, or 86,400 seconds (24 hours). A rule with no `retry` has no retry policy, and EventBridge uses the same defaults. EventBridge invokes the function asynchronously, so an error that the handler throws is not a failed delivery. Lambda retries such an invocation itself, as it does for any asynchronous invocation.

The rule sends the EventBridge event to the function as it is.

### Validating events

`lambda.decode(event)` validates the event's `detail` with the rule's `schema`. It returns the event with the validated value in place of `detail`, so `detail` has the schema's output type. The detail is already an object, so `decode()` doesn't parse JSON. When the detail is not valid, `decode()` throws a `DecodeError` whose `part` is `"detail"`. See [Validating bodies with `decode()`](../../manual/functions.md#validating-bodies-with-decode).

Import the schema from a shared module, such as `shared/schema.ts` in `files.shared`, or from a package. **This matters because the function loads the schema, but not the infra module.** In the function's bundle, the runtime build replaces `ordersBus` with `{}`:

```ts [runtime/fulfil-order.ts, as the runtime build strips it]
export const lambda = $lambda({
  id: "fulfil-order",
  event: () =>
    eventBridge.bind({}).defineRule({
      id: "order-placed",
      pattern: { source: ["shop"], "detail-type": ["OrderPlaced"] },
      schema: OrderPlaced,
    }),
});
```

The `infra/orders` import is gone. The other options stay as they are, so `schema` must come from a shared module or a package, and `pattern` can't refer to a value from an infra module.

## `eventBridge.schema(schema)`

A declaration that infra makes rules for names the schema of their detail, and no rule:

```ts [runtime/record-shipment.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { OrderShipped } from "shared/schema";

export const lambda = $lambda({
  id: "record-shipment",
  event: () => eventBridge.schema(OrderShipped),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { detail: shipment } = await lambda.decode(event);
  console.log(shipment.orderId, shipment.carrier);
};
```

`lambda.decode(event)` validates the event's detail with `OrderShipped`, as it does with the rule's schema for `defineRule()`. The declaration doesn't import infra, so the runtime build leaves `eventBridge.schema(OrderShipped)` as it is.

`eventBridge.schema(null)` declares a function that receives scheduled events, which have no detail. See [`schedule(config)`](#scheduleconfig). `eventBridge.schema()` with no argument is a type error.

## `rule(config)`

`rule()` sends the events on a bus that match a pattern to a function, from infra. It makes the same rule and permission as `defineRule()`. It returns nothing.

```ts [infra/orders.ts]
import { eventBus, rule } from "@notation/aws/event-bridge";
import { lambda as recordShipment } from "runtime/record-shipment";

export const ordersBus = eventBus({ id: "orders" });

rule({
  id: "order-shipped",
  bus: ordersBus,
  pattern: { source: ["shop"], "detail-type": ["OrderShipped"] },
  target: () => recordShipment,
});
```

`runtime/record-shipment.ts` is the declaration with `eventBridge.schema(OrderShipped)` above. `rule()` takes no schema: the function validates each event's detail with the schema of its declaration. Nothing checks that the events that the pattern matches have a detail that the schema accepts, so an event that does not fit fails in `decode()`.

```ts [@notation/aws/event-bridge]
type RuleConfig = RuleOptions & {
  bus: EventBus;
  target: RuleTarget;
};
```

The other options are the [options of `defineRule()`](#options), without `schema`. `bus` is a bus from `eventBus()` or `defaultEventBus()`.

`target` is a declaration, passed as a function such as `() => recordShipment`, or a Lambda group from [`lambda()`](lambda.md#lambdaconfig), passed as it is. See [Wiring a declaration](lambda.md#wiring-a-declaration). The target can be:

| Target                                                  | Result   |
| ------------------------------------------------------- | -------- |
| A declaration with `eventBridge.schema(OrderShipped)`   | Targeted |
| A declaration with no `event`                           | Targeted |
| A Lambda group from `lambda()`                          | Targeted |
| A declaration with `eventBridge.schema(null)`           | Throws   |
| A declaration with `defineRule()` or `defineSchedule()` | Throws   |

A declaration with `eventBridge.schema(null)` receives scheduled events, so `rule()` throws for it, and it is a type error too.

A declaration with `defineRule()` already makes its rule, so `rule()` throws for it. Make the rule in one place: remove the `rule()` call, or declare the function with `eventBridge.schema()`.

To send the events of several patterns to one function, declare it with `eventBridge.schema()`, and call `rule()` once for each pattern. Each rule makes its own permission.

## `eventBridge.defineSchedule(options)`

A declaration names its schedule in `event`:

```ts [runtime/nightly-digest.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { rate } from "@notation/aws/event-bridge";

export const lambda = $lambda({
  id: "nightly-digest",
  event: () =>
    eventBridge.defineSchedule({
      id: "nightly-digest",
      schedule: rate(1, "day"),
    }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("digest for", event.time);
};
```

When infra has finished loading, the declaration makes an EventBridge rule on the default bus that targets the function, and the permission that lets the rule invoke it. Infra declares nothing for it.

The runtime build keeps the options. `@notation/aws/event-bridge` sets `"sideEffects": false`, so the bundle includes `rate()` and leaves out the rest of the package.

```ts [@notation/aws/lambda]
type ScheduleOptions = {
  id: string;
  name?: string;
  schedule: Schedule;
};
```

`id` and `name` work as they do for [`schedule()`](#scheduleconfig).

## `schedule(config)`

Infra makes a schedule for a declaration with `eventBridge.schema(null)`:

::code-group

```ts [infra/schedule.ts]
import { schedule, rate } from "@notation/aws/event-bridge";
import { lambda as logEvent } from "runtime/log-event";

schedule({
  id: "log-every-minute",
  schedule: rate(1, "minute"),
  target: () => logEvent,
});
```

```ts [runtime/log-event.ts]
import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "log-event",
  event: () => eventBridge.schema(null),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("Scheduled event fired:", event);
};
```

::

A scheduled event has no detail, so its function declares `eventBridge.schema(null)`, and has no `decode()`.

`logEvent` is the declaration from the runtime module `runtime/log-event.ts`. `schedule` takes it as a function, `() => logEvent`, and calls the function when infra has finished loading. See [Wiring a declaration](lambda.md#wiring-a-declaration). `schedule` creates the same rule and permission as `defineSchedule()`. It returns nothing.

### Schedule config

```ts [@notation/aws/event-bridge]
type ScheduleConfig = {
  id: string;
  name?: string;
  schedule: Schedule;
  target: ScheduleTarget; // RuleTarget<null>: () => declaration, or a Lambda group
};
```

`target` can be a declaration with `eventBridge.schema(null)`, a declaration with no `event`, or a Lambda group from [`lambda()`](lambda.md#lambdaconfig). A declaration with a detail schema, such as `eventBridge.schema(OrderShipped)`, receives the events of rules, so `schedule()` throws for it. A declaration with `eventBridge.defineSchedule()` already makes its schedule, so `schedule()` throws for it too. Schedule the function in one place: remove the `schedule()` call, or declare the function with `eventBridge.schema(null)`.

The rule sends the EventBridge event to the function as it is.

`id` keys the schedule in state, so changing it replaces the rule. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. In AWS, the EventBridge rule is named `<app>--<stage>--<id>`, such as `my-app--prod--log-every-minute`.

`name` replaces the `id` in the rule's AWS name, so `name: "every-minute"` names the rule `my-app--prod--every-minute`. Changing `name` also replaces the rule. See [AWS names](../../manual/project-config.md#aws-names).

## Schedule types

### `rate(value, unit)`

```ts [infra/schedule.ts]
import { rate } from "@notation/aws/event-bridge";

rate(1, "minute");
rate(5, "minutes");
rate(1, "hour");
rate(12, "hours");
rate(1, "day");
```

```ts [@notation/aws/event-bridge]
type RateUnit = "minute" | "minutes" | "hour" | "hours" | "day" | "days";
```

### `cron(expression)`

```ts [infra/schedule.ts]
import { cron } from "@notation/aws/event-bridge";

cron("0 12 * * ? *");
cron("0/15 * * * ? *");
```

### `once(date)`

```ts [infra/schedule.ts]
import { once } from "@notation/aws/event-bridge";

once(new Date("2027-12-31T23:59:00Z"));
```

## Handler

`LambdaHandler<typeof lambda>` types `event` from the declaration:

| `event`                                                                     | Handler event                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| `eventBridge.bind(bus).defineRule(options)` or `eventBridge.schema(schema)` | `EventBridgeEvent<string, unknown>`            |
| `eventBridge.defineSchedule(options)` or `eventBridge.schema(null)`         | `EventBridgeEvent<"Scheduled Event", unknown>` |

The handler's `event.detail` is `unknown`. `decode()` returns the event with `detail` typed as the schema's output.
