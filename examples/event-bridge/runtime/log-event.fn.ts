import { LambdaConfig, handle } from "@notation/aws/lambda.fn";

export const logEvent = handle.eventBridgeScheduledEvent((event) => {
  console.log(JSON.stringify(event));
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "log-event",
  timeout: 5,
  memory: 64,
};
