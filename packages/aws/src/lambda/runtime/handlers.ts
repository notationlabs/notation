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

/** The kind of event that a handler made with `handle.*` takes. */
export type HandlerKind = "api" | "schedule" | "sqs" | "dynamodb";

// Marks the functions that `handle.*` returns with their kind, so the
// dispatcher can tell handlers from other exported functions. `Symbol.for`
// gives the same symbol to every copy of this package.
const handlerKind = Symbol.for("@notation/aws/handler");

export function getHandlerKind(value: unknown): HandlerKind | undefined {
  if (typeof value !== "function") return undefined;
  return (value as any)[handlerKind];
}

const wrap = <H extends (...args: any[]) => any>(
  kind: HandlerKind,
  handler: H,
): Handled<H> => {
  const wrapped = async (...args: Parameters<H>) => handler(...args);
  Object.defineProperty(wrapped, handlerKind, { value: kind });
  return wrapped as unknown as Handled<H>;
};

export const handle = {
  apiRequest: (handler: ApiGatewayHandler) => wrap("api", handler),
  jwtAuthorizedApiRequest: <T>(handler: JWTAuthorizedApiGatewayHandler<T>) =>
    wrap("api", handler),
  eventBridgeScheduledEvent: (
    handler: EventBridgeHandler<"Scheduled Event", any>,
  ) => wrap("schedule", handler),
  dynamoDbStream: (handler: DynamoDbStreamHandler) => wrap("dynamodb", handler),
  dynamoDbBatch: (handler: DynamoDbBatchHandler) => wrap("dynamodb", handler),
  sqsEvent: (handler: SqsHandler) => wrap("sqs", handler),
  sqsBatch: (handler: SqsBatchHandler) => wrap("sqs", handler),
};
