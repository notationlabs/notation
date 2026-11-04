import { queue } from "@notation/aws/sqs";
import * as checkout from "../runtime/checkout" with { type: "runtime" };

export const orderQueue = queue({ name: "orders" });
orderQueue.consume(checkout.processOrder);
