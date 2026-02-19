import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import * as z from "zod";
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

const stageSchema = stage.defineSchema({
  StageName: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  ApiId: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  AccessLogSettings: {
    valueType: z.object({
      DestinationArn: z.string().optional(),
      Format: z.string().optional(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  AutoDeploy: {
    valueType: z.boolean(),
    propertyType: "param",
    presence: "optional",
  },
  ClientCertificateId: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  DefaultRouteSettings: {
    valueType: z.object({
      DataTraceEnabled: z.boolean().optional(),
      DetailedMetricsEnabled: z.boolean().optional(),
      LoggingLevel: z.enum(["OFF", "ERROR", "INFO"]).optional(),
      ThrottlingBurstLimit: z.number().optional(),
      ThrottlingRateLimit: z.number().optional(),
    }),
    propertyType: "param",
    presence: "optional",
  },
  DeploymentId: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  RouteSettings: {
    valueType: z.record(
      z.string(),
      z.object({
        DataTraceEnabled: z.boolean().optional(),
        DetailedMetricsEnabled: z.boolean().optional(),
        LoggingLevel: z.enum(["OFF", "ERROR", "INFO"]).optional(),
        ThrottlingBurstLimit: z.number().optional(),
        ThrottlingRateLimit: z.number().optional(),
      }),
    ),
    propertyType: "param",
    presence: "optional",
  },
  StageVariables: {
    valueType: z.record(z.string()),
    propertyType: "param",
    presence: "optional",
  },
  Tags: {
    valueType: z.record(z.string()),
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
} as const);

export const Stage = stageSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.CreateStageCommand(params);
      await apiGatewayClient.send(command);
    },
    read: async (key) => {
      const command = new sdk.GetStageCommand(key);
      return apiGatewayClient.send(command);
    },
    update: async (key, params) => {
      const command = new sdk.UpdateStageCommand({ ...key, ...params });
      await apiGatewayClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.DeleteStageCommand(key);
      await apiGatewayClient.send(command);
    },
  })
  .requireDependencies<StageDependencies>()
  .deriveParams(({ deps }) => ({
    ApiId: deps.api.output.ApiId!,
  }));

export type StageInstance = InstanceType<typeof Stage>;
