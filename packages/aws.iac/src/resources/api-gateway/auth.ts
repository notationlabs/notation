import * as sdk from "@aws-sdk/client-apigatewayv2";
import { AwsSchema } from "src/utils/types";
import { resource } from "@notation/resource";
import z from "zod";
import { apiGatewayClient } from "src/utils/aws-clients";
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
});

const apiSchema = authorizer.defineSchema({
  ApiId: {
    valueType: z.string(),
    presence: "required",
    propertyType: "param",
    secondaryKey: true,
  },
  AuthorizerId: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  Name: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
  },
  AuthorizerType: {
    valueType: z.enum([sdk.AuthorizerType.JWT, sdk.AuthorizerType.REQUEST]),
    propertyType: "param",
    presence: "required",
  },
  IdentitySource: {
    valueType: z.array(z.string()),
    presence: "required",
    propertyType: "param",
  },
  JwtConfiguration: {
    valueType: z
      .object({
        Audience: z.array(z.string()),
        Issuer: z.string(),
      })
      .optional(),
    propertyType: "param",
    presence: "optional",
  },
} as const);

export const RouteAuth = apiSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateAuthorizerCommand(params);
      const result = await apiGatewayClient.send(command);

      return {
        AuthorizerId: result.AuthorizerId!,
      };
    },
    read: async (key) => {
      const command = new sdk.GetAuthorizerCommand(key);
      const result = await apiGatewayClient.send(command);

      return result;
    },
    update: async (key, patch, params) => {
      const command = new sdk.UpdateAuthorizerCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (params) => {
      const command = new sdk.DeleteAuthorizerCommand(params);
      await apiGatewayClient.send(command);
    },
  })
  .requireDependencies<AuthorizerDependencies>()
  .deriveParams(({ deps }) => ({
    ApiId: deps.api.output.ApiId,
  }));

export type AuthInstance = InstanceType<typeof RouteAuth>;
