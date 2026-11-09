import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as refunds } from "runtime/refunds";
import { Order, Refund } from "shared/schema";

export const orderDeadLetterQueue = queue({ id: "orders-dlq", schema: Order });

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  deadLetterQueue: { queue: orderDeadLetterQueue, maxReceiveCount: 3 },
});

export const refundQueue = queue({ id: "refunds", schema: Refund });

eventSourceMapping({ source: refundQueue, target: () => refunds });
