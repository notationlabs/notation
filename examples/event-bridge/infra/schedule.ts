import { schedule, rate } from "@notation/aws/event-bridge";
import { lambda as logEvent } from "runtime/log-event";

schedule({
  id: "log-every-minute",
  schedule: rate(1, "minute"),
  target: () => logEvent,
});
