import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { rate } from "@notation/aws/event-bridge";

// The declaration makes its own schedule, so infra doesn't wire it.
export const lambda = $lambda({
  id: "nightly-digest",
  timeout: 5,
  memory: 64,
  event: () =>
    eventBridge.defineSchedule({
      id: "nightly-digest",
      schedule: rate(1, "day"),
    }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log("digest for", event.time);
};
