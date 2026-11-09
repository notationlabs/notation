import { queue } from "@notation/aws/sqs";
import { Order } from "shared/schema";

export const orderQueue = queue({ name: "orders", schema: Order });

export const refundQueue = queue({ name: "refunds" });
