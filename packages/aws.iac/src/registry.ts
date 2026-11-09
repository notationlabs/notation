import type { ResourceClass } from "@notation/resource";
import * as apiGateway from "./resources/api-gateway";
import * as eventBridge from "./resources/event-bridge";
import * as lambda from "./resources/lambda";
import * as sqs from "./resources/sqs";

/**
 * Every resource class that this package defines, deprecated ones included.
 * Deploy and destroy find the class of an orphaned state record here, so a
 * record can be deleted after its type has left the graph.
 */
export const resourceClasses: readonly ResourceClass<any, any, any>[] = [
  apiGateway.Api,
  apiGateway.LambdaIntegration,
  apiGateway.Route,
  apiGateway.RouteAuth,
  apiGateway.Stage,
  eventBridge.EventBridgeRule,
  eventBridge.LambdaEventBridgeRulePermission,
  lambda.LambdaApiGatewayV2Permission,
  lambda.LambdaEventSourceMapping,
  lambda.LambdaFunction,
  lambda.LambdaIamRole,
  lambda.LambdaLogGroup,
  lambda.LambdaPermission,
  lambda.LambdaRolePolicy,
  lambda.LambdaRolePolicyAttachment,
  sqs.Queue,
];
