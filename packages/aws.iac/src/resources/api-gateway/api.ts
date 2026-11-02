import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/utils/aws-clients";
import {
  CREATE_TOKEN_TAG,
  createTokenTagValue,
  withoutCreateTokenTag,
} from "src/utils/create-token";
import { awsCreate } from "src/utils/errors";
import { findInPages } from "src/utils/paginate";
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

const cors = v.object({
  AllowCredentials: v.optional(v.boolean()),
  AllowHeaders: v.optional(v.array(v.string())),
  AllowMethods: v.optional(v.array(v.string())),
  AllowOrigins: v.optional(v.array(v.string())),
  ExposeHeaders: v.optional(v.array(v.string())),
  MaxAge: v.optional(v.number()),
});

const apiSchema = api.defineSchema({
  ApiId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  ApiEndpoint: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  ApiGatewayManaged: {
    propertyType: "computed",
    presence: "optional",
    value: v.boolean(),
  },
  ApiKeySelectionExpression: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  CorsConfiguration: {
    propertyType: "param",
    presence: "optional",
    value: cors,
  },
  CreatedDate: {
    propertyType: "computed",
    presence: "required",
    volatile: true,
    value: v.date(),
  },
  Description: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  DisableExecuteApiEndpoint: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  DisableSchemaValidation: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  ImportInfo: {
    propertyType: "computed",
    presence: "optional",
    value: v.array(v.string()),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  ProtocolType: {
    propertyType: "param",
    immutable: true,
    presence: "required",
    value: v.enum(sdk.ProtocolType),
  },
  RouteKey: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  RouteSelectionExpression: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  Tags: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.record(v.string(), v.string()),
  },
  Warnings: {
    propertyType: "computed",
    presence: "optional",
    value: v.array(v.string()),
  },
  Version: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
} as const);

export const Api = apiSchema.defineOperations({
  // An API's ID is assigned by AWS, and its name need not be unique, so the
  // create attempt is recorded as a tag for `find` to search for.
  create: awsCreate(async (params, _context, token) => {
    const tags = token
      ? { ...params.Tags, [CREATE_TOKEN_TAG]: createTokenTagValue(token) }
      : params.Tags;
    const command = new sdk.CreateApiCommand({ ...params, Tags: tags });
    const result = await apiGatewayClient.send(command);
    return { ApiId: result.ApiId! };
  }),
  async find(_params, token) {
    const value = createTokenTagValue(token);
    const api = await findInPages(
      (NextToken) =>
        apiGatewayClient.send(new sdk.GetApisCommand({ NextToken })),
      (item) => item.Tags?.[CREATE_TOKEN_TAG] === value,
    );
    if (api) return { ApiId: api.ApiId! };
    throw new ResourceNotFoundError("No API Gateway API has the create token");
  },
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
