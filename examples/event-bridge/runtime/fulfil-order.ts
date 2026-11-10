import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { ordersBus } from "infra/orders";
import { OrderPlaced } from "shared/schema";

// The declaration makes its own rule on the bus that infra declares.
export const lambda = $lambda({
  id: "fulfil-order",
  timeout: 5,
  memory: 64,
  event: () =>
    eventBridge.bind(ordersBus).defineRule({
      id: "order-placed",
      pattern: { source: ["shop"], "detail-type": ["OrderPlaced"] },
      schema: OrderPlaced,
    }),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { detail: order } = await lambda.decode(event);
  console.log("fulfil", order.orderId, order.total);
};
