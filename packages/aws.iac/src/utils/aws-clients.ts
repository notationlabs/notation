import { STSClient } from "@aws-sdk/client-sts";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { IAMClient } from "@aws-sdk/client-iam";
import { region } from "src/config";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SQSClient } from "@aws-sdk/client-sqs";

// Constructing an SDK client reads the AWS config files and environment, so
// each client is constructed on the first call and reused after that. Then
// importing a module that uses a client has no side effects.
function lazy<T>(create: () => T): () => T {
  let client: T | undefined;
  return () => (client ??= create());
}

export const stsClient = lazy(() => new STSClient({ region }));
export const cloudWatchLogsClient = lazy(
  () => new CloudWatchLogsClient({ region }),
);
export const lambdaClient = lazy(() => new LambdaClient({ region }));
export const apiGatewayClient = lazy(() => new ApiGatewayV2Client({ region }));
export const iamClient = lazy(() => new IAMClient({ region }));
export const eventBridgeClient = lazy(() => new EventBridgeClient({ region }));
export const sqsClient = lazy(() => new SQSClient({ region }));
