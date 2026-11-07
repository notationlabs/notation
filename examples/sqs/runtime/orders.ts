import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { orderQueue } from "infra/orders";

export const lambda = $lambda({
  id: "orders",
  timeout: 5,
  memory: 64,
  event: () => sqs(),
  env: () => ({ ORDER_QUEUE_URL: orderQueue.url }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const order = await lambda.decode(record);
    console.log("order from", lambda.env().ORDER_QUEUE_URL, order);
  }
};
