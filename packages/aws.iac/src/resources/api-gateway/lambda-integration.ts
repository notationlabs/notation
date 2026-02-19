import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import * as z from "zod";
import { ApiInstance } from "./api";
import { LambdaFunctionInstance } from "../lambda";
import { getLambdaInvocationUri } from "src/templates/arn";
import { apiGatewayClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";

export type LambdaIntegrationSchema = AwsSchema<{
  Key: sdk.DeleteIntegrationRequest;
  CreateParams: sdk.CreateIntegrationRequest;
  UpdateParams: sdk.UpdateIntegrationRequest;
  ReadResult: sdk.GetIntegrationResult;
}>;

export type LambdaIntegrationDependencies = {
  api: ApiInstance;
  lambda: LambdaFunctionInstance;
};

const integration = resource<LambdaIntegrationSchema>({
  type: "aws/apiGateway/LambdaIntegration",
});

const integrationSchema = integration.defineSchema({
  IntegrationId: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  ApiId: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  ApiGatewayManaged: {
    valueType: z.boolean(),
    propertyType: "computed",
    presence: "optional",
  },
  ConnectionId: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  ConnectionType: {
    valueType: z.enum(["INTERNET", "VPC_LINK"]),
    defaultValue: "INTERNET",
    propertyType: "param",
    presence: "optional",
  },
  ContentHandlingStrategy: {
    valueType: z.enum(["CONVERT_TO_BINARY", "CONVERT_TO_TEXT"]),
    propertyType: "param",
    presence: "optional",
  },
  CredentialsArn: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  IntegrationMethod: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  IntegrationSubtype: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  IntegrationType: {
    valueType: z.enum(["AWS", "AWS_PROXY", "HTTP", "HTTP_PROXY", "MOCK"]),
    propertyType: "param",
    presence: "required",
    immutable: true,
  },
  IntegrationUri: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  PassthroughBehavior: {
    valueType: z.enum(["NEVER", "WHEN_NO_MATCH", "WHEN_NO_TEMPLATES"]),
    propertyType: "param",
    presence: "optional",
  },
  PayloadFormatVersion: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  RequestParameters: {
    valueType: z.record(z.string()),
    propertyType: "param",
    presence: "optional",
  },
  RequestTemplates: {
    valueType: z.record(z.string()),
    propertyType: "param",
    presence: "optional",
  },
  ResponseParameters: {
    valueType: z.record(z.record(z.string())),
    propertyType: "param",
    presence: "optional",
  },
  TemplateSelectionExpression: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  TimeoutInMillis: {
    valueType: z.number(),
    propertyType: "param",
    presence: "optional",
  },
  TlsConfig: {
    valueType: z.object({
      ServerNameToVerify: z.string().optional(),
    }),
    propertyType: "param",
    presence: "optional",
  },
} as const);

export const LambdaIntegration = integrationSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateIntegrationCommand(params);
      const result = await apiGatewayClient.send(command);
      return { IntegrationId: result.IntegrationId! };
    },
    read: async (key) => {
      const command = new sdk.GetIntegrationCommand(key);
      return apiGatewayClient.send(command);
    },
    update: async (key, params) => {
      const command = new sdk.UpdateIntegrationCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.DeleteIntegrationCommand(key);
      await apiGatewayClient.send(command);
    },
  })
  .requireDependencies<LambdaIntegrationDependencies>()
  .deriveParams(({ deps }) => ({
    ApiId: deps.api.output.ApiId,
    IntegrationType: "AWS_PROXY",
    IntegrationMethod: "POST",
    IntegrationUri: getLambdaInvocationUri(deps.lambda.output.FunctionArn!),
    PayloadFormatVersion: "2.0",
    PassthroughBehavior: "WHEN_NO_MATCH",
    ConnectionType: "INTERNET",
  }));

export type LambdaIntegrationInstance = InstanceType<typeof LambdaIntegration>;
