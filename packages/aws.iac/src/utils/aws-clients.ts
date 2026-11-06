import { STSClient } from "@aws-sdk/client-sts";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { IAMClient } from "@aws-sdk/client-iam";
import { region } from "src/config";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SQSClient } from "@aws-sdk/client-sqs";

// A client reads the AWS config files and environment when it is
// constructed. Infra modules are also evaluated inside a Lambda, so each
// client is constructed when it is first used.
// Every trap goes to the client, so that tests can spy on its methods.
function lazy<T extends object>(create: () => T): T {
  let client: T | undefined;
  const get = () => (client ??= create());
  return new Proxy({} as T, {
    get(_target, key) {
      const value = Reflect.get(get(), key);
      return typeof value === "function" ? value.bind(get()) : value;
    },
    set: (_target, key, value) => Reflect.set(get(), key, value),
    has: (_target, key) => Reflect.has(get(), key),
    defineProperty: (_target, key, descriptor) =>
      Reflect.defineProperty(get(), key, descriptor),
    deleteProperty: (_target, key) => Reflect.deleteProperty(get(), key),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(get(), key);
      // A proxy may not report a property as non-configurable when its
      // target does not have it.
      return descriptor && { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(get()),
  });
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
