import { eventSourceMapping } from "@notation/aws/lambda";
import { queue } from "@notation/aws/sqs";
import { lambda as refunds } from "runtime/refunds";
import { Order, Refund } from "shared/schema";

export const orderQueue = queue({ id: "orders", schema: Order });

export const refundQueue = queue({ id: "refunds", schema: Refund });

eventSourceMapping({ source: refundQueue, target: () => refunds });
