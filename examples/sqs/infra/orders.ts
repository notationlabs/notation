import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as refunds } from "runtime/refunds";
import { Order, Refund } from "shared/schema";

export const orderQueue = queue({ name: "orders", schema: Order });

export const refundQueue = queue({ name: "refunds", schema: Refund });

eventSourceMapping({ source: refundQueue, target: () => refunds });
