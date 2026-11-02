import { schedule, rate } from "@notation/aws/event-bridge";
import { externalJsLambda } from "./lambda";

export const myschedule = schedule({
  name: "my-schedule",
  schedule: rate(1, "minute"),
  handler: externalJsLambda,
});
