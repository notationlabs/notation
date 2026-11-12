import * as v from "valibot";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { AwsSchema } from "src/resources/utils/types";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { apiGatewayClient } from "src/resources/utils/aws-clients";
import { findOnlyInPages } from "src/resources/utils/paginate";
import { ApiInstance } from "./api";

type AuthorizerSdkSchema = AwsSchema<{
  Key: sdk.GetAuthorizerRequest;
  CreateParams: sdk.CreateAuthorizerRequest;
  UpdateParams: sdk.UpdateAuthorizerRequest;
  ReadResult: sdk.GetAuthorizerResponse;
}>;

type AuthorizerDependencies = {
  api: ApiInstance;
};

const authorizer = resource<AuthorizerSdkSchema>({
  type: "aws/apiGateway/Authorizer",
  provider: "@notation/aws/resources",
});

const jwtConfiguration = v.object({
  Audience: v.optional(v.array(v.string())),
  Issuer: v.optional(v.string()),
});

const apiSchema = authorizer.defineSchema({
  ApiId: {
    presence: "required",
    propertyType: "param",
    secondaryKey: true,
    value: v.string(),
  },
  AuthorizerId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  AuthorizerType: {
    propertyType: "param",
    presence: "required",
    value: v.enum(sdk.AuthorizerType),
  },
  IdentitySource: {
    presence: "required",
    propertyType: "param",
    value: v.array(v.string()),
  },
  JwtConfiguration: {
    propertyType: "param",
    presence: "optional",
    value: jwtConfiguration,
  },
} as const);

export const RouteAuth = apiSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateAuthorizerCommand(params);
      const result = await apiGatewayClient().send(command);

      return {
        AuthorizerId: result.AuthorizerId!,
      };
    },
    // AWS assigns the authorizer's ID, so `find` matches on the name within
    // the API.
    find: async (params) => {
      let authorizer;
      try {
        authorizer = await findOnlyInPages(
          (NextToken) =>
            apiGatewayClient().send(
              new sdk.GetAuthorizersCommand({ ApiId: params.ApiId, NextToken }),
            ),
          (item) => item.Name === params.Name,
          `API Gateway authorizer named ${params.Name} in API ${params.ApiId}`,
          (item) => item.AuthorizerId!,
        );
      } catch (error) {
        // GetAuthorizers throws this when the API does not exist, and then
        // the authorizer does not exist either.
        if (error instanceof sdk.NotFoundException) {
          throw new ResourceNotFoundError(
            "The API of the API Gateway authorizer was not found",
            { cause: error },
          );
        }
        throw error;
      }
      return { AuthorizerId: authorizer.AuthorizerId! };
    },
    read: async (key) => {
      try {
        const command = new sdk.GetAuthorizerCommand(key);
        const output = await apiGatewayClient().send(command);
        return output;
      } catch (error) {
        if (error instanceof sdk.NotFoundException) {
          throw new ResourceNotFoundError(
            "API Gateway authorizer was not found",
            { cause: error },
          );
        }
        throw error;
      }
    },
    update: async (key, patch, params) => {
      const command = new sdk.UpdateAuthorizerCommand({ ...key, ...params });
      await apiGatewayClient().send(command);
    },
    delete: async (params) => {
      try {
        const command = new sdk.DeleteAuthorizerCommand(params);
        await apiGatewayClient().send(command);
      } catch (error) {
        if (!(error instanceof sdk.NotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<AuthorizerDependencies>()
  .deriveParams(({ deps }) => ({
    ApiId: deps.api.output.ApiId,
  }));

export type AuthInstance = InstanceType<typeof RouteAuth>;
