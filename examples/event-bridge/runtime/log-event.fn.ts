import {
  createLambda,
  scheduled,
  type LambdaHandler,
} from "@notation/aws/lambda";

export const lambda = createLambda({
  id: "log-event",
  timeout: 5,
  memory: 64,
  event: () => scheduled(),
});

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  console.log(JSON.stringify(event));
};
