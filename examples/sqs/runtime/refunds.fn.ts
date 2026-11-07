import { createLambda, sqs, type LambdaHandler } from "@notation/aws/lambda";

export const lambda = createLambda({
  id: "refunds",
  timeout: 5,
  memory: 64,
  event: () => sqs(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  for (const record of event.Records) console.log("refund", record.body);
};
