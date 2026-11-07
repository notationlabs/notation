# EventBridge

`@notation/aws/event-bridge` creates scheduled Lambda invocations with EventBridge.

## `schedule(config)`

```ts [infra/schedule.ts]
import * as eventBridge from "@notation/aws/event-bridge";
import { lambda as logEvent } from "runtime/log-event";

eventBridge.schedule({
  name: "log-every-minute",
  schedule: eventBridge.rate(1, "minute"),
  target: () => logEvent,
});
```

`logEvent` is the declaration from the runtime module `runtime/log-event.ts`. `schedule` takes it as a function, `() => logEvent`, and calls the function when infra has finished loading. The declaration must have `event: () => scheduled()`, or no `event`. See [Wiring a declaration](lambda.md#wiring-a-declaration). `target` can also be a Lambda group from [`lambda()`](lambda.md#lambdaconfig), as it is. `schedule` creates an EventBridge rule that targets the function, and the permission that lets the rule invoke it. It returns nothing.

### Config

```ts [@notation/aws/event-bridge.ts]
type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  target: LambdaTarget<"scheduled" | "none">; // () => declaration, or a Lambda group
};
```

The rule sends the EventBridge event to the function as it is.

`name` keys the schedule in state. In AWS, the EventBridge rule is named `<app>--<stage>--<name>`, such as `my-app--prod--log-every-minute`. See [AWS names](../manual/project-config.md#aws-names).

## Schedule types

### `rate(value, unit)`

```ts [infra/schedule.ts]
eventBridge.rate(1, "minute");
eventBridge.rate(5, "minutes");
eventBridge.rate(1, "hour");
eventBridge.rate(12, "hours");
eventBridge.rate(1, "day");
```

```ts [@notation/aws/event-bridge.ts]
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

```ts [runtime/log-event.ts]
import { $lambda, scheduled, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "log-event",
  event: () => scheduled(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("Scheduled event fired:", event);
};
```

`event` is typed as an `EventBridgeEvent<"Scheduled Event", unknown>`.
