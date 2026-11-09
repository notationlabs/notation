import { schedule, rate } from "@notation/aws/event-bridge";
import { externalJsLambda } from "./lambda";

schedule({
  id: "my-schedule",
  schedule: rate(1, "minute"),
  target: externalJsLambda,
});
