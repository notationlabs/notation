import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { Refund } from "shared/schema";

// infra/orders.ts maps the refund queue to this function.
export const lambda = $lambda({
  id: "refunds",
  timeout: 5,
  memory: 64,
  event: () => sqs.schema(Refund),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) {
    const { body: refund } = await lambda.decode(record);
    console.log("refund for", refund.orderId, refund.reason);
  }
};
