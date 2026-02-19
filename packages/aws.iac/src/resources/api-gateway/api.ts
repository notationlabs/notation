import { resource } from "@notation/resource";
import * as z from "zod";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";

type ApiSdkSchema = AwsSchema<{
  Key: sdk.DeleteApiRequest;
  CreateParams: sdk.CreateApiRequest;
  UpdateParams: sdk.UpdateApiRequest;
  ReadResult: sdk.GetApiResponse;
}>;

const api = resource<ApiSdkSchema>({
  type: "aws/apiGateway/Api",
});

const apiSchema = api.defineSchema({
  ApiId: {
    propertyType: "computed",
    valueType: z.string(),
    presence: "required",
    primaryKey: true,
  },
  ApiEndpoint: {
    propertyType: "computed",
    valueType: z.string(),
    presence: "required",
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    valueType: z.boolean(),
    presence: "optional",
  },
  ApiKeySelectionExpression: {
    propertyType: "param",
    valueType: z.string(),
    presence: "optional",
  },
  CorsConfiguration: {
    propertyType: "param",
    valueType: z.object({
      AllowCredentials: z.boolean().optional(),
      AllowHeaders: z.array(z.string()).optional(),
      AllowMethods: z.array(z.string()).optional(),
      AllowOrigins: z.array(z.string()).optional(),
      ExposeHeaders: z.array(z.string()).optional(),
      MaxAge: z.number().optional(),
    }),
    presence: "optional",
  },
  CreatedDate: {
    propertyType: "computed",
    valueType: z.date(),
    presence: "required",
    volatile: true,
  },
  Description: {
    propertyType: "param",
    valueType: z.string(),
    presence: "optional",
  },
  DisableExecuteApiEndpoint: {
    propertyType: "param",
    valueType: z.boolean(),
    presence: "optional",
  },
  DisableSchemaValidation: {
    propertyType: "param",
    valueType: z.boolean(),
    presence: "optional",
  },
  ImportInfo: {
    propertyType: "computed",
    valueType: z.array(z.string()),
    presence: "optional",
  },
  Name: {
    propertyType: "param",
    valueType: z.string(),
    presence: "required",
  },
  ProtocolType: {
    propertyType: "param",
    valueType: z.enum(["HTTP", "WEBSOCKET"]),
    defaultValue: "HTTP",
    immutable: true,
    presence: "required",
  },
  RouteKey: {
    propertyType: "param",
    valueType: z.string(),
    presence: "optional",
  },
  RouteSelectionExpression: {
    propertyType: "param",
    valueType: z.string(),
    presence: "optional",
  },
  Tags: {
    propertyType: "param",
    valueType: z.record(z.string()),
    presence: "optional",
    immutable: true,
  },
  Warnings: {
    propertyType: "computed",
    valueType: z.array(z.string()),
    presence: "optional",
  },
  Version: {
    propertyType: "param",
    valueType: z.string(),
    presence: "optional",
  },
} as const);

export const Api = apiSchema.defineOperations({
  async create(params) {
    const command = new sdk.CreateApiCommand(params);
    const result = await apiGatewayClient.send(command);
    return { ApiId: result.ApiId! };
  },
  async read(key) {
    const command = new sdk.GetApiCommand(key);
    const result = await apiGatewayClient.send(command);
    // todo: check types or correct or if RouteKey is actually in result
    // if not, need to pass the original params to read
    return { RouteKey: "", ...result };
  },
  async update(key, params) {
    const command = new sdk.UpdateApiCommand({ ...key, ...params });
    await apiGatewayClient.send(command);
  },
  async delete(pk) {
    const command = new sdk.DeleteApiCommand(pk);
    await apiGatewayClient.send(command);
  },
});

export type ApiInstance = InstanceType<typeof Api>;
