import { handle, type LambdaResource } from "@notation/aws/lambda.fn";

export const logEvent = handle.eventBridgeScheduledEvent((event) => {
  console.log(JSON.stringify(event));
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "log-event",
  timeout: 5,
  memory: 64,
};
