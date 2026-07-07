import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/utils/aws-clients";
import { ApiInstance, LambdaIntegrationInstance } from ".";
import { AwsSchema } from "src/utils/types";
import { AuthInstance } from "./auth";

type RouteSdkSchema = AwsSchema<{
  Key: sdk.DeleteRouteRequest;
  CreateParams: sdk.CreateRouteRequest;
  UpdateParams: sdk.UpdateRouteRequest;
  ReadResult: sdk.GetRouteResult;
}>;

type RouteDependencies = {
  api: ApiInstance;
  lambdaIntegration: LambdaIntegrationInstance;
  auth?: AuthInstance;
};

const route = resource<RouteSdkSchema>({
  type: "aws/apiGateway/Route",
});

export const routeSchema = route.defineSchema({
  RouteId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  ApiId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  ApiKeyRequired: {
    propertyType: "param",
    presence: "optional",
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
  },
  AuthorizationScopes: {
    propertyType: "param",
    presence: "optional",
  },
  AuthorizationType: {
    propertyType: "param",
    presence: "optional",
  },
  AuthorizerId: {
    propertyType: "param",
    presence: "optional",
  },
  ModelSelectionExpression: {
    propertyType: "param",
    presence: "optional",
  },
  OperationName: {
    propertyType: "param",
    presence: "optional",
  },
  RequestModels: {
    propertyType: "param",
    presence: "optional",
  },
  RequestParameters: {
    propertyType: "param",
    presence: "optional",
  },
  RouteKey: {
    propertyType: "param",
    presence: "required",
  },
  RouteResponseSelectionExpression: {
    propertyType: "param",
    presence: "optional",
  },
  Target: {
    propertyType: "param",
    presence: "optional",
  },
} as const);

export const Route = routeSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateRouteCommand(params);
      const result = await apiGatewayClient.send(command);

      return { RouteId: result.RouteId! };
    },
    read: async (key) => {
      const command = new sdk.GetRouteCommand(key);
      const result = await apiGatewayClient.send(command);
      return { ...key, ...result };
    },
    update: async (key, patch, params) => {
      const command = new sdk.UpdateRouteCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.DeleteRouteCommand(key);
      await apiGatewayClient.send(command);
    },
  })
  .requireDependencies<RouteDependencies>()
  .deriveParams(({ deps }) => {
    const authConfig = deps.auth
      ? { AuthorizerId: deps.auth.output.AuthorizerId }
      : {};

    return {
      ApiId: deps.api.output.ApiId,
      // todo: this is too opinionated, should be somewhere else
      Target: `integrations/${deps.lambdaIntegration.output.IntegrationId}`,
      ...authConfig,
    };
  });

export type RouteInstance = InstanceType<typeof Route>;
