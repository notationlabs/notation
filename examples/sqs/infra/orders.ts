import { api, router } from "@notation/aws/api-gateway";
import { queue } from "@notation/aws/sqs";
import { createOrder } from "runtime/checkout.fn" with { type: "runtime" };
import {
  processOrders,
  processRefunds,
} from "runtime/orders.fn" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(processOrders, { batchSize: 5 });

export const refundQueue = queue({ name: "refunds" });
refundQueue.consume(processRefunds);

const ordersApi = router(api({ name: "orders-api" }));
ordersApi.post("/orders", createOrder);
