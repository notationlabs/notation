# EventBridge

`@notation/aws/event-bridge` creates scheduled Lambda invocations with EventBridge.

## `schedule(config)`

```ts [infra/schedule.ts]
import * as eventBridge from "@notation/aws/event-bridge";
import { logEvent } from "runtime/log-event.fn";

eventBridge.schedule({
  name: "log-every-minute",
  schedule: eventBridge.rate(1, "minute"),
  handler: logEvent,
});
```

The `handler` import from a `.fn.ts` file triggers the same [compiler transform](../internals/compiler.md) as API Gateway routes. The handler export is replaced with a `lambda()` resource declaration, and `schedule` wires it to an EventBridge rule with the required invoke permission.

### Config

```ts [@notation/aws/event-bridge.ts]
type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  handler: EventBridgeHandler;
};
```

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

::code-group

```ts [runtime/log-event.fn.ts]
import { handle } from "@notation/aws/lambda.fn";

export const logEvent = handle.eventBridgeScheduledEvent((event) => {
  console.log("Scheduled event fired:", event);
});
```

```ts [dist/runtime/log-event.fn.ts]
export const logEvent = async (event) => {
  console.log("Scheduled event fired:", event);
};
```

::

The EventBridge `schedule` call then takes this Lambda resource and generates the rule, target, and invoke permission automatically.
