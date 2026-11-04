import type { Handler } from "@notation/resource";
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

/** `H`, marked as a handler of the function `F`. */
export type HandlerOf<H extends (...args: any[]) => any, F> = H &
  Handler<Parameters<H>[0], ReturnType<H>, F>;

/**
 * The `handle` of a Lambda function that a runtime module declares. Each
 * method makes a handler of one kind of event. `F` is the function's type.
 */
export type Handle<F> = {
  apiRequest(handler: ApiGatewayHandler): HandlerOf<ApiGatewayHandler, F>;
  jwtAuthorizedApiRequest<T>(
    handler: JWTAuthorizedApiGatewayHandler<T>,
  ): HandlerOf<JWTAuthorizedApiGatewayHandler<T>, F>;
  eventBridgeScheduledEvent(
    handler: EventBridgeScheduleHandler,
  ): HandlerOf<EventBridgeScheduleHandler, F>;
  dynamoDbStream(
    handler: DynamoDbStreamHandler,
  ): HandlerOf<DynamoDbStreamHandler, F>;
  dynamoDbBatch(
    handler: DynamoDbBatchHandler,
  ): HandlerOf<DynamoDbBatchHandler, F>;
  sqsEvent(handler: SqsHandler): HandlerOf<SqsHandler, F>;
  sqsBatch(handler: SqsBatchHandler): HandlerOf<SqsBatchHandler, F>;
};

export const handlerKinds: Record<keyof Handle<unknown>, HandlerKind> = {
  apiRequest: "api",
  jwtAuthorizedApiRequest: "api",
  eventBridgeScheduledEvent: "schedule",
  dynamoDbStream: "dynamodb",
  dynamoDbBatch: "dynamodb",
  sqsEvent: "sqs",
  sqsBatch: "sqs",
};
