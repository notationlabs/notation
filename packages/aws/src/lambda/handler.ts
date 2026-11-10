import type {
  Context,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  EventBridgeEvent,
  DynamoDBStreamEvent,
  DynamoDBBatchResponse,
  SQSEvent,
  SQSBatchResponse,
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayEventRequestContextV2WithAuthorizer,
  APIGatewayEventRequestContextJWTAuthorizer,
} from "aws-lambda";

// With payload format 2.0, API Gateway sends a returned value that has no
// `statusCode` as a JSON body, with status 200.
export type ApiGatewayResult = APIGatewayProxyResultV2<
  object | number | boolean | null
>;

export type ApiGatewayHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => ApiGatewayResult | Promise<ApiGatewayResult>;

/**
 * A request through a route with a JWT authorizer, with the token's claims
 * typed as `T`.
 */
export type APIGatewayJWTProxyEventV2<T> =
  APIGatewayProxyEventV2WithRequestContext<
    APIGatewayEventRequestContextV2WithAuthorizer<
      Omit<APIGatewayEventRequestContextJWTAuthorizer, "jwt"> & {
        jwt: { claims: T; scopes: string[] };
      }
    >
  >;

export type JWTAuthorizedApiGatewayHandler<ClaimsType> = (
  event: APIGatewayJWTProxyEventV2<ClaimsType>,
  context: Context,
) => ApiGatewayResult | Promise<ApiGatewayResult>;

export type EventBridgeHandler<TypeDescription extends string, DetailType> = (
  event: EventBridgeEvent<TypeDescription, DetailType>,
  context: Context,
) => void | Promise<void>;

export type EventBridgeScheduleHandler = EventBridgeHandler<
  "Scheduled Event",
  any
>;
export type DynamoDbStreamHandler = (
  event: DynamoDBStreamEvent,
  context: Context,
) => void | Promise<void>;

export type DynamoDbBatchHandler = (
  event: DynamoDBBatchResponse,
  context: Context,
) => void | Promise<void>;

export type SqsHandler = (
  event: SQSEvent,
  context: Context,
) => void | Promise<void>;

export type SqsBatchHandler = (
  event: SQSBatchResponse,
  context: Context,
) => void | Promise<void>;
