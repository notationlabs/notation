import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/utils/aws-clients";
import {
  CREATE_TOKEN_TAG,
  createTokenTagValue,
  withoutCreateTokenTag,
} from "src/utils/create-token";
import { isUncertainAwsError } from "src/utils/errors";
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
  // An API's ID is assigned by AWS, and its name need not be unique, so the
  // create attempt is recorded as a tag for findCreated to search for.
  async create(params, _context, token) {
    const tags = token
      ? { ...params.Tags, [CREATE_TOKEN_TAG]: createTokenTagValue(token) }
      : params.Tags;
    const command = new sdk.CreateApiCommand({ ...params, Tags: tags });
    const result = await apiGatewayClient.send(command);
    return { ApiId: result.ApiId! };
  },
  async findCreated(_params, token) {
    const value = createTokenTagValue(token);
    let nextToken: string | undefined;
    do {
      const page = await apiGatewayClient.send(
        new sdk.GetApisCommand({ NextToken: nextToken }),
      );
      const api = page.Items?.find(
        (item) => item.Tags?.[CREATE_TOKEN_TAG] === value,
      );
      if (api) return { ApiId: api.ApiId! };
      nextToken = page.NextToken;
    } while (nextToken);
    throw new ResourceNotFoundError("No API Gateway API has the create token");
  },
  isUncertainError: isUncertainAwsError,
  async read(key) {
    try {
      const command = new sdk.GetApiCommand(key);
      const result = await apiGatewayClient.send(command);
      // todo: check types or correct or if RouteKey is actually in result
      // if not, need to pass the original params to read
      return {
        RouteKey: "",
        ...result,
        Tags: withoutCreateTokenTag(result.Tags),
      };
    } catch (error) {
      if (error instanceof sdk.NotFoundException) {
        throw new ResourceNotFoundError("API Gateway API was not found", {
          cause: error,
        });
      }
      throw error;
    }
  },
  async update(key, params) {
    const command = new sdk.UpdateApiCommand({ ...key, ...params });
    await apiGatewayClient.send(command);
  },
  async delete(pk) {
    try {
      const command = new sdk.DeleteApiCommand(pk);
      await apiGatewayClient.send(command);
    } catch (error) {
      if (!(error instanceof sdk.NotFoundException)) throw error;
    }
  },
});

export type ApiInstance = InstanceType<typeof Api>;
