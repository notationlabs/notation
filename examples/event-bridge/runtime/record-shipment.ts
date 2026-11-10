import { $lambda, eventBridge, type LambdaHandler } from "@notation/aws/lambda";
import { OrderShipped } from "shared/schema";

export const lambda = $lambda({
  id: "record-shipment",
  timeout: 5,
  memory: 64,
  event: () => eventBridge.schema(OrderShipped),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  const { detail: shipment } = await lambda.decode(event);
  console.log("shipped", shipment.orderId, "by", shipment.carrier);
};
