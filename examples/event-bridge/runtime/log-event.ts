import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = $lambda({
  id: "log-event",
  timeout: 5,
  memory: 64,
  event: () => eventBridge.schema(null),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log(JSON.stringify(event));
};
