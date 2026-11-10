import * as v from "valibot";
import { ResourceNotFoundError } from "@notation/resource";
import { resource } from "src/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import { ApiInstance } from "./api";
import { apiGatewayClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";

export type StageSchema = AwsSchema<{
  Key: sdk.DeleteStageRequest;
  CreateParams: sdk.CreateStageRequest;
  UpdateParams: sdk.UpdateStageRequest;
  ReadResult: sdk.GetStageResponse;
}>;

type StageDependencies = {
  api: ApiInstance;
};

const stage = resource<StageSchema>({
  type: "aws/apiGateway/Stage",
});

const accessLogSettings = v.object({
  DestinationArn: v.optional(v.string()),
  Format: v.optional(v.string()),
});

const routeSettings = v.object({
  DataTraceEnabled: v.optional(v.boolean()),
  DetailedMetricsEnabled: v.optional(v.boolean()),
  LoggingLevel: v.optional(v.enum(sdk.LoggingLevel)),
  ThrottlingBurstLimit: v.optional(v.number()),
  ThrottlingRateLimit: v.optional(v.number()),
});

const stageSchema = stage.defineSchema({
  StageName: {
    propertyType: "param",
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
  AccessLogSettings: {
    propertyType: "param",
    presence: "optional",
    value: accessLogSettings,
  },
  AutoDeploy: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  ClientCertificateId: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  DefaultRouteSettings: {
    propertyType: "param",
    presence: "optional",
    value: routeSettings,
  },
  DeploymentId: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  Description: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  RouteSettings: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), routeSettings),
  },
  StageVariables: {
    propertyType: "param",
    presence: "optional",
    value: v.record(v.string(), v.string()),
  },
  Tags: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.record(v.string(), v.string()),
  },
} as const);

export const Stage = stageSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateStageCommand(params);
      await apiGatewayClient().send(command);
    },
    read: async (key) => {
      try {
        const command = new sdk.GetStageCommand(key);
        const output = await apiGatewayClient().send(command);
        return output;
      } catch (error) {
        if (error instanceof sdk.NotFoundException) {
          throw new ResourceNotFoundError("API Gateway stage was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },
    update: async (key, params) => {
      const command = new sdk.UpdateStageCommand({ ...key, ...params });
      await apiGatewayClient().send(command);
    },
    delete: async (key) => {
      try {
        const command = new sdk.DeleteStageCommand(key);
        await apiGatewayClient().send(command);
      } catch (error) {
        if (!(error instanceof sdk.NotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<StageDependencies>()
  .deriveParams(({ deps }) => ({
    ApiId: deps.api.output.ApiId!,
  }));

export type StageInstance = InstanceType<typeof Stage>;
