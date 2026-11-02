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

`logEvent` is an export of the runtime module `runtime/log-event.fn.ts`, so in infra code it is a `RuntimeRef`: the module's Lambda function, plus the name of the export. See [Lambda](lambda.md#runtime-modules). `schedule` creates an EventBridge rule that targets the function, and the permission that lets the rule invoke it.

### Config

```ts [@notation/aws/event-bridge.ts]
type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  handler: RuntimeRef;
};
```

The rule doesn't send the EventBridge event to the function as it is. It sends `{ "export": "logEvent", "event": <the EventBridge event> }`, so the function knows which export to call. The function's dispatcher calls `logEvent` with the EventBridge event. See [Dispatch](lambda.md#dispatch).

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

```ts [runtime/log-event.fn.ts]
import { handle, type LambdaResource } from "@notation/aws/lambda.fn";

export const logEvent = handle.eventBridgeScheduledEvent((event) => {
  console.log("Scheduled event fired:", event);
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "log-event",
};
```
