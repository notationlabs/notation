import { resource } from "@notation/resource";
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
    presence: "required",
    primaryKey: true,
  },
  ApiEndpoint: {
    propertyType: "computed",
    presence: "required",
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
  },
  ApiKeySelectionExpression: {
    propertyType: "param",
    presence: "optional",
  },
  CorsConfiguration: {
    propertyType: "param",
    presence: "optional",
  },
  CreatedDate: {
    propertyType: "computed",
    presence: "required",
    volatile: true,
  },
  Description: {
    propertyType: "param",
    presence: "optional",
  },
  DisableExecuteApiEndpoint: {
    propertyType: "param",
    presence: "optional",
  },
  DisableSchemaValidation: {
    propertyType: "param",
    presence: "optional",
  },
  ImportInfo: {
    propertyType: "computed",
    presence: "optional",
  },
  Name: {
    propertyType: "param",
    presence: "required",
  },
  ProtocolType: {
    propertyType: "param",
    defaultValue: "HTTP",
    immutable: true,
    presence: "required",
  },
  RouteKey: {
    propertyType: "param",
    presence: "optional",
  },
  RouteSelectionExpression: {
    propertyType: "param",
    presence: "optional",
  },
  Tags: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  Warnings: {
    propertyType: "computed",
    presence: "optional",
  },
  Version: {
    propertyType: "param",
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
