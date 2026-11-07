import * as eventBridge from "@notation/aws/event-bridge";
import { lambda as logEvent } from "runtime/log-event";

eventBridge.schedule({
  name: "log-every-minute",
  schedule: eventBridge.rate(1, "minute"),
  target: () => logEvent,
});
