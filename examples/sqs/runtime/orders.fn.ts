import { LambdaConfig, handle } from "@notation/aws/lambda.fn";

export const processOrders = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("order", record.body);
});

export const processRefunds = handle.sqsEvent((event) => {
  for (const record of event.Records) console.log("refund", record.body);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "orders",
  timeout: 5,
  memory: 64,
};
