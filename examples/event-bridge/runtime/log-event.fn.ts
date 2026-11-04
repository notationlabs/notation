import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "log-event", timeout: 5, memory: 64 });

export const logEvent = handle.eventBridgeScheduledEvent((event) => {
  console.log(JSON.stringify(event));
});
