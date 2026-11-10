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
  event: () =>
    sqs.bind(orderQueue, { batchSize: 5, reportBatchItemFailures: true }),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const { body: order } = await lambda.decode(record);
      console.log("order from", lambda.env().ORDER_QUEUE_URL, order.orderId);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      // Only this message returns to the queue. After 3 receives, SQS moves
      // it to the dead-letter queue.
      console.error("invalid order", record.messageId, error.issues);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
