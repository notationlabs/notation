import {
  $lambda,
  DecodeError,
  sqs,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  timeout: 5,
  memory: 64,
  event: () => sqs(orderQueue, { batchSize: 5 }),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    try {
      const order = await lambda.decode(record);
      console.log("order from", lambda.env().ORDER_QUEUE_URL, order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      // A message that fails validation fails again on every retry, so log it and skip it.
      console.error("invalid order", record.messageId, error.issues);
    }
  }
};
