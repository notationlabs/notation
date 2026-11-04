import { lambda } from "@notation/aws/lambda" with { type: "infra" };

const { handle } = lambda({ id: "orders", timeout: 5, memory: 64 });

export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("order", record.body);
});

export const processRefunds = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("refund", record.body);
});
