import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders.fn";
import { lambda as processRefunds } from "runtime/refunds.fn";

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(() => processOrders, { batchSize: 5 });

export const refundQueue = queue({ name: "refunds" });
refundQueue.consume(() => processRefunds);
