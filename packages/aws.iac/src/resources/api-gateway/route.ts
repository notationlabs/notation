import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/utils/aws-clients";
import { awsCreate } from "src/utils/errors";
import { findInPages } from "src/utils/paginate";
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
    create: awsCreate(async (params) => {
      const command = new sdk.CreateRouteCommand(params);
      const result = await apiGatewayClient.send(command);

      return { RouteId: result.RouteId! };
    }),
    // A route key is unique within an API, so it finds the route that a
    // create attempt made.
    find: async (params) => {
      const route = await findInPages(
        (NextToken) =>
          apiGatewayClient.send(
            new sdk.GetRoutesCommand({ ApiId: params.ApiId, NextToken }),
          ),
        (item) => item.RouteKey === params.RouteKey,
      );
      if (route) return { RouteId: route.RouteId! };
      throw new ResourceNotFoundError("No API Gateway route has the route key");
    },
    read: async (key) => {
      try {
        const command = new sdk.GetRouteCommand(key);
        const result = await apiGatewayClient.send(command);
        return { ...key, ...result };
      } catch (error) {
        if (error instanceof sdk.NotFoundException) {
          throw new ResourceNotFoundError("API Gateway route was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },
    update: async (key, patch, params) => {
      const command = new sdk.UpdateRouteCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (key) => {
      try {
        const command = new sdk.DeleteRouteCommand(key);
        await apiGatewayClient.send(command);
      } catch (error) {
        if (!(error instanceof sdk.NotFoundException)) throw error;
      }
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
