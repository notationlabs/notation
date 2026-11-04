import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
import { sendMessage } from "./sqs-client";

const { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});

export const createOrder = handle.apiRequest(async (req) => {
  await sendMessage(orderQueue.url, req.body ?? "");
  return json({ ok: true });
});

export const processOrder = handle.sqsEvent(async (event) => {
  for (const record of event.Records) console.log("processing", record.body);
});
