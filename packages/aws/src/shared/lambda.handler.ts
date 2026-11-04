import type {
  Context,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  EventBridgeEvent,
  DynamoDBStreamEvent,
  DynamoDBBatchResponse,
  SQSEvent,
  SQSBatchResponse,
  APIGatewayProxyEventV2WithJWTAuthorizer,
} from "aws-lambda";

export type ApiGatewayHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => APIGatewayProxyResultV2 | Promise<APIGatewayProxyResultV2>;

export type TypedClaimsOverride<T> = {
  requestContext: {
    authorizer: {
      jwt: {
        claims: T;
        scopes: string[];
      };
    };
  };
};

export type APIGatewayJWTProxyEventV2<T> = Omit<
  APIGatewayProxyEventV2WithJWTAuthorizer,
  "requestContext"
> &
  TypedClaimsOverride<T>;

export type JWTAuthorizedApiGatewayHandler<ClaimsType> = (
  event: APIGatewayJWTProxyEventV2<ClaimsType>,
  context: Context,
) => APIGatewayProxyResultV2 | Promise<APIGatewayProxyResultV2>;

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
  event: DynamoDBStreamEvent,
  context: Context,
) => DynamoDBBatchResponse | Promise<DynamoDBBatchResponse>;

export type SqsHandler = (
  event: SQSEvent,
  context: Context,
) => void | Promise<void>;

export type SqsBatchHandler = (
  event: SQSEvent,
  context: Context,
) => SQSBatchResponse | Promise<SQSBatchResponse>;
