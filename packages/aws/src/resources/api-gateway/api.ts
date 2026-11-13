import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { apiGatewayClient } from "src/resources/utils/aws-clients";
import { executeApiSourceArn } from "src/resources/templates/arn";
import { awsCreate } from "src/resources/utils/errors";
import { findOnlyInPages } from "src/resources/utils/paginate";
import { AwsSchema } from "src/resources/utils/types";
import { nameRules } from "src/naming";

type ApiSdkSchema = AwsSchema<{
  Key: sdk.DeleteApiRequest;
  CreateParams: sdk.CreateApiRequest;
  UpdateParams: sdk.UpdateApiRequest;
  ReadResult: sdk.GetApiResponse & { ExecuteApiSourceArn: string };
}>;

const api = resource<ApiSdkSchema>({
  type: "aws/apiGateway/Api",
  provider: "@notation/aws/resources",
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
  // Built from the API ID, so that a Lambda permission can place it whole as
  // its SourceArn. GetApi does not return it.
  ExecuteApiSourceArn: {
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
    physicalName: nameRules.apiGatewayApi,
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
  create: awsCreate(async (params) => {
    const command = new sdk.CreateApiCommand(params);
    const result = await apiGatewayClient().send(command);
    return { ApiId: result.ApiId! };
  }),
  // AWS assigns the API's ID, and does not keep its name unique. The name
  // that Notation gives an API is unique, so `find` matches on the name and
  // fails when several APIs have it.
  async find(params) {
    const api = await findOnlyInPages(
      (NextToken) =>
        apiGatewayClient().send(new sdk.GetApisCommand({ NextToken })),
      (item) => item.Name === params.Name,
      `API Gateway API named ${params.Name}`,
      (item) => item.ApiId!,
    );
    return { ApiId: api.ApiId! };
  },
  async read(key) {
    try {
      const command = new sdk.GetApiCommand(key);
      const result = await apiGatewayClient().send(command);
      // todo: check types or correct or if RouteKey is actually in result
      // if not, need to pass the original params to read
      return {
        RouteKey: "",
        ...result,
        Tags: withoutCreateTokenTag(result.Tags),
        ExecuteApiSourceArn: await executeApiSourceArn(key.ApiId!),
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
    await apiGatewayClient().send(command);
  },
  async delete(pk) {
    try {
      const command = new sdk.DeleteApiCommand(pk);
      await apiGatewayClient().send(command);
    } catch (error) {
      if (!(error instanceof sdk.NotFoundException)) throw error;
    }
  },
});

export type ApiInstance = InstanceType<typeof Api>;

// Earlier versions tagged each API they created with this tag. Read leaves
// it out, so that it is not compared with `Tags` in config, which would
// replace the API.
const CREATE_TOKEN_TAG = "notation:create-token";

function withoutCreateTokenTag(
  tags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags || !(CREATE_TOKEN_TAG in tags)) return tags;
  const { [CREATE_TOKEN_TAG]: _, ...rest } = tags;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
