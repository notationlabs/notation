import type {
  ApiGatewayHandler,
  DynamoDbBatchHandler,
  DynamoDbStreamHandler,
  SqsBatchHandler,
  SqsHandler,
  EventBridgeHandler,
  JWTAuthorizedApiGatewayHandler,
} from "src/shared/lambda.handler";
import type { RuntimeRef } from "src/lambda";

/**
 * Infra imports a runtime module through a generated module, whose exports
 * are `RuntimeRef`s. TypeScript types the import from the original module,
 * so each handler is also typed as a `RuntimeRef`, for infra to pass to APIs
 * such as `route()`. The function itself has no `resource` or `export`.
 */
type Handled<H> = H & RuntimeRef;

const wrap = <H extends (...args: any[]) => any>(handler: H): Handled<H> =>
  (async (...args: Parameters<H>) => handler(...args)) as unknown as Handled<H>;

export const handle = {
  apiRequest: (handler: ApiGatewayHandler) => wrap(handler),
  jwtAuthorizedApiRequest: <T>(handler: JWTAuthorizedApiGatewayHandler<T>) =>
    wrap(handler),
  eventBridgeScheduledEvent: (
    handler: EventBridgeHandler<"Scheduled Event", any>,
  ) => wrap(handler),
  dynamoDbStream: (handler: DynamoDbStreamHandler) => wrap(handler),
  dynamoDbBatch: (handler: DynamoDbBatchHandler) => wrap(handler),
  sqsEvent: (handler: SqsHandler) => wrap(handler),
  sqsBatch: (handler: SqsBatchHandler) => wrap(handler),
};
