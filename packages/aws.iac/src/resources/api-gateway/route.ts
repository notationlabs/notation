import * as v from "valibot";
import { ResourceNotFoundError } from "@notation/resource";
import { resource } from "src/resource";
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
    value: v.string(),
  },
  ApiId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
    value: v.string(),
  },
  ApiKeyRequired: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
    value: v.boolean(),
  },
  AuthorizationScopes: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.string()),
  },
  AuthorizationType: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.AuthorizationType),
  },
  AuthorizerId: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  ModelSelectionExpression: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  OperationName: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  RequestModels: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
  },
  RequestParameters: {
    propertyType: "param",
    presence: "optional",
    value: v.record(
      v.string(),
      v.object({ Required: v.optional(v.boolean()) }),
    ),
  },
  RouteKey: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  RouteResponseSelectionExpression: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  Target: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
} as const);

export const Route = routeSchema
  .defineOperations({
    create: awsCreate(async (params) => {
      const command = new sdk.CreateRouteCommand(params);
      const result = await apiGatewayClient().send(command);

      return { RouteId: result.RouteId! };
    }),
    // A route key is unique within an API, so it finds the route that a
    // create attempt made.
    find: async (params) => {
      const route = await findInPages(
        (NextToken) =>
          apiGatewayClient().send(
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
        const result = await apiGatewayClient().send(command);
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
      await apiGatewayClient().send(command);
    },
    delete: async (key) => {
      try {
        const command = new sdk.DeleteRouteCommand(key);
        await apiGatewayClient().send(command);
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
