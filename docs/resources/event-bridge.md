# EventBridge

`@notation/aws/event-bridge` creates scheduled Lambda invocations with EventBridge. A Lambda function receives the events of a schedule in one of two ways:

| Function-led                                                | Infra-led                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `event: () => eventBridge.defineSchedule({ id, schedule })` | `event: () => eventBridge.schema(null)`                          |
| The declaration makes the schedule.                         | Infra makes schedules with `schedule({ id, schedule, target })`. |

`eventBridge` comes from `@notation/aws/lambda`. `schedule()`, `rate()`, `cron()` and `once()` come from `@notation/aws/event-bridge`.

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

When infra has finished loading, the declaration makes an EventBridge rule that targets the function, and the permission that lets the rule invoke it. Infra declares nothing for it.

The function doesn't read the schedule, so the runtime build removes the options: the call becomes `eventBridge.defineSchedule(undefined)`, and the `rate` import goes with it.

```ts [@notation/aws/lambda]
type ScheduleOptions = {
  id: string;
  name?: string;
  schedule: Schedule;
};
```

`id` and `name` work as they do for [`schedule()`](#config).

## `schedule(config)`

Infra makes a schedule for a declaration with `eventBridge.schema(null)`:

::code-group

```ts [infra/schedule.ts]
import * as eventBridge from "@notation/aws/event-bridge";
import { lambda as logEvent } from "runtime/log-event";

eventBridge.schedule({
  id: "log-every-minute",
  schedule: eventBridge.rate(1, "minute"),
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

`eventBridge.schema()` takes the schema of the event's detail. A scheduled event has no detail, so the only value it takes is `null`, and `eventBridge.schema()` with no argument is a type error.

`logEvent` is the declaration from the runtime module `runtime/log-event.ts`. `schedule` takes it as a function, `() => logEvent`, and calls the function when infra has finished loading. See [Wiring a declaration](lambda.md#wiring-a-declaration). `schedule` creates the same rule and permission as `defineSchedule()`. It returns nothing.

### Config

```ts [@notation/aws/event-bridge]
type ScheduleConfig = {
  id: string;
  name?: string;
  schedule: Schedule;
  target: LambdaTarget<"eventBridge" | "none">; // () => declaration, or a Lambda group
};
```

`target` can be a declaration with `eventBridge.schema(null)`, a declaration with no `event`, or a Lambda group from [`lambda()`](lambda.md#lambdaconfig). A declaration with `eventBridge.defineSchedule()` already makes its schedule, so `schedule()` throws for it. Schedule the function in one place: remove the `schedule()` call, or declare the function with `eventBridge.schema(null)`.

The rule sends the EventBridge event to the function as it is.

`id` keys the schedule in state, so changing it replaces the rule. Use 1 to 64 letters, digits, hyphens and underscores, as a string literal. In AWS, the EventBridge rule is named `<app>--<stage>--<id>`, such as `my-app--prod--log-every-minute`.

`name` replaces the `id` in the rule's AWS name, so `name: "every-minute"` names the rule `my-app--prod--every-minute`. Changing `name` also replaces the rule. See [AWS names](../manual/project-config.md#aws-names).

## Schedule types

### `rate(value, unit)`

```ts [infra/schedule.ts]
eventBridge.rate(1, "minute");
eventBridge.rate(5, "minutes");
eventBridge.rate(1, "hour");
eventBridge.rate(12, "hours");
eventBridge.rate(1, "day");
```

```ts [@notation/aws/event-bridge]
type RateUnit = "minute" | "minutes" | "hour" | "hours" | "day" | "days";
```

### `cron(expression)`

```ts [infra/schedule.ts]
eventBridge.cron("0 12 * * ? *");
eventBridge.cron("0/15 * * * ? *");
```

### `once(date)`

```ts [infra/schedule.ts]
eventBridge.once(new Date("2027-12-31T23:59:00Z"));
```

## Handler

`LambdaHandler<typeof lambda>` types `event` as an `EventBridgeEvent<"Scheduled Event", unknown>`, for both forms.
