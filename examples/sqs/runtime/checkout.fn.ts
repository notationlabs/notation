import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "infra/orders" with { type: "infra" };

const sqs = new SQSClient();

const { handle } = lambda({
  id: "checkout",
  timeout: 5,
  grants: [orderQueue.grant(["SendMessage"])],
});

export const createOrder = handle.apiRequest(async (req) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: orderQueue.url,
      MessageBody: req.body ?? "{}",
    }),
  );
  return json({ ok: true });
});
