import { resource } from "@notation/resource";
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

const stageSchema = stage.defineSchema({
  StageName: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  ApiId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  AccessLogSettings: {
    propertyType: "param",
    presence: "optional",
  },
  AutoDeploy: {
    propertyType: "param",
    presence: "optional",
  },
  ClientCertificateId: {
    propertyType: "param",
    presence: "optional",
  },
  DefaultRouteSettings: {
    propertyType: "param",
    presence: "optional",
  },
  DeploymentId: {
    propertyType: "param",
    presence: "optional",
  },
  Description: {
    propertyType: "param",
    presence: "optional",
  },
  RouteSettings: {
    propertyType: "param",
    presence: "optional",
  },
  StageVariables: {
    propertyType: "param",
    presence: "optional",
  },
  Tags: {
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
