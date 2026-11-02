import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
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
    value: v.string(),
  },
  ApiId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
    value: v.string(),
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
    value: v.boolean(),
  },
  ConnectionId: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  ConnectionType: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.ConnectionType),
  },
  ContentHandlingStrategy: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.ContentHandlingStrategy),
  },
  CredentialsArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  Description: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  IntegrationMethod: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  IntegrationSubtype: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.string(),
  },
  IntegrationType: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.enum(sdk.IntegrationType),
  },
  IntegrationUri: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  PassthroughBehavior: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.PassthroughBehavior),
  },
  PayloadFormatVersion: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  RequestParameters: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
  },
  RequestTemplates: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
  },
  ResponseParameters: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.record(v.string(), v.string())),
  },
  TemplateSelectionExpression: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  TimeoutInMillis: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(v.number(), v.integer()),
  },
  TlsConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({ ServerNameToVerify: v.optional(v.string()) }),
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
      try {
        const command = new sdk.GetIntegrationCommand(key);
        const output = await apiGatewayClient.send(command);
        return output;
      } catch (error) {
        if (error instanceof sdk.NotFoundException) {
          throw new ResourceNotFoundError(
            "API Gateway integration was not found",
            { cause: error },
          );
        }
        throw error;
      }
    },
    update: async (key, params) => {
      const command = new sdk.UpdateIntegrationCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (key) => {
      try {
        const command = new sdk.DeleteIntegrationCommand(key);
        await apiGatewayClient.send(command);
      } catch (error) {
        if (!(error instanceof sdk.NotFoundException)) throw error;
      }
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
