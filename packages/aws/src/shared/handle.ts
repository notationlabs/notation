import type { Handler } from "@notation/resource";
import type { LambdaGroup } from "src/lambda";
import type {
  ApiGatewayHandler,
  DynamoDbBatchHandler,
  DynamoDbStreamHandler,
  EventBridgeScheduleHandler,
  JWTAuthorizedApiGatewayHandler,
  SqsBatchHandler,
  SqsHandler,
} from "./lambda.handler";

/** The kind of event that a handler made with `handle.*` takes. */
export type HandlerKind = "api" | "schedule" | "sqs" | "dynamodb";

/**
 * A handler that `handle.<kind>(fn)` returns, for a Lambda handler `H`. Infra
 * imports a runtime module `with { type: "runtime" }`, and sees each handler
 * as a `LambdaRef` through the generated declarations.
 *
 * `@notation/aws/lambda` and `@notation/aws/lambda.fn` both export it, so that
 * declaration emit can name it in the type of a user's export.
 */
export type LambdaHandler<H extends (event: any, context: any) => unknown> =
  Handler<Parameters<H>[0], Awaited<ReturnType<H>>, LambdaGroup>;

/**
 * The `handle` of a Lambda function that a runtime module declares. Each
 * method makes a handler of one kind of event.
 */
export type Handle = {
  apiRequest(handler: ApiGatewayHandler): LambdaHandler<ApiGatewayHandler>;
  jwtAuthorizedApiRequest<T>(
    handler: JWTAuthorizedApiGatewayHandler<T>,
  ): LambdaHandler<JWTAuthorizedApiGatewayHandler<T>>;
  eventBridgeScheduledEvent(
    handler: EventBridgeScheduleHandler,
  ): LambdaHandler<EventBridgeScheduleHandler>;
  dynamoDbStream(
    handler: DynamoDbStreamHandler,
  ): LambdaHandler<DynamoDbStreamHandler>;
  dynamoDbBatch(
    handler: DynamoDbBatchHandler,
  ): LambdaHandler<DynamoDbBatchHandler>;
  sqsEvent(handler: SqsHandler): LambdaHandler<SqsHandler>;
  sqsBatch(handler: SqsBatchHandler): LambdaHandler<SqsBatchHandler>;
};

export const handlerKinds: Record<keyof Handle, HandlerKind> = {
  apiRequest: "api",
  jwtAuthorizedApiRequest: "api",
  eventBridgeScheduledEvent: "schedule",
  dynamoDbStream: "dynamodb",
  dynamoDbBatch: "dynamodb",
  sqsEvent: "sqs",
  sqsBatch: "sqs",
};
