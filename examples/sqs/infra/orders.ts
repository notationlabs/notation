import { queue } from "@notation/aws/sqs";
import { processOrders, processRefunds } from "runtime/orders.fn";

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });

export const refundQueue = queue({ name: "refunds" });
refundQueue.consume(processRefunds);
