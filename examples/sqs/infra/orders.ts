import { queue } from "@notation/aws/sqs";
import { lambda as processOrders } from "runtime/orders";
import { lambda as processRefunds } from "runtime/refunds";

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(() => processOrders, { batchSize: 5 });

export const refundQueue = queue({ name: "refunds" });
refundQueue.consume(() => processRefunds);
