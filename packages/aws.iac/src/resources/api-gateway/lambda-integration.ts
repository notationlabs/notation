import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
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
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  ApiId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
  },
  ConnectionId: {
    propertyType: "param",
    presence: "optional",
  },
  ConnectionType: {
    defaultValue: "INTERNET",
    propertyType: "param",
    presence: "optional",
  },
  ContentHandlingStrategy: {
    propertyType: "param",
    presence: "optional",
  },
  CredentialsArn: {
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    propertyType: "param",
    presence: "optional",
  },
  IntegrationMethod: {
    propertyType: "param",
    presence: "optional",
  },
  IntegrationSubtype: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  IntegrationType: {
    propertyType: "param",
    presence: "required",
    immutable: true,
  },
  IntegrationUri: {
    propertyType: "param",
    presence: "optional",
  },
  PassthroughBehavior: {
    propertyType: "param",
    presence: "optional",
  },
  PayloadFormatVersion: {
    propertyType: "param",
    presence: "optional",
  },
  RequestParameters: {
    propertyType: "param",
    presence: "optional",
  },
  RequestTemplates: {
    propertyType: "param",
    presence: "optional",
  },
  ResponseParameters: {
    propertyType: "param",
    presence: "optional",
  },
  TemplateSelectionExpression: {
    propertyType: "param",
    presence: "optional",
  },
  TimeoutInMillis: {
    propertyType: "param",
    presence: "optional",
  },
  TlsConfig: {
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
