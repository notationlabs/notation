import { getAwsAccountId } from "src/context";
import { region } from "src/config";

export const getLambdaInvocationUri = (arn: string) => {
  return `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${arn}/invocations`;
};

/** The ARN that matches every stage, method and path of an HTTP API. */
export const executeApiSourceArn = async (apiId: string) => {
  const accountId = await getAwsAccountId();
  return `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*`;
};
