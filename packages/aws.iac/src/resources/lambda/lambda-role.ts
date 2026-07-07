import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { lambdaTrustPolicy } from "src/templates/iam.policy";

export type LambdaIamRoleSchema = AwsSchema<{
  Key: sdk.DeleteRoleRequest;
  CreateParams: sdk.CreateRoleRequest;
  UpdateParams: sdk.UpdateRoleRequest;
  ReadResult: NonNullable<sdk.GetRoleResponse["Role"]>;
}>;

const lambdaIamRole = resource<LambdaIamRoleSchema>({
  type: "aws/lambda/LambdaIamRole",
});

const lambdaIamRoleSchema = lambdaIamRole.defineSchema({
  RoleName: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  Arn: {
    propertyType: "computed",
    presence: "required",
  },
  AssumeRolePolicyDocument: {
    propertyType: "param",
    presence: "required",
    immutable: true,
  },
  CreateDate: {
    propertyType: "computed",
    presence: "required",
    volatile: true,
  },
  Description: {
    propertyType: "param",
    presence: "optional",
  },
  MaxSessionDuration: {
    propertyType: "param",
    presence: "optional",
  },
  Path: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  PermissionsBoundary: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  RoleId: {
    propertyType: "computed",
    presence: "required",
  },
  RoleLastUsed: {
    propertyType: "computed",
    presence: "optional",
  },
} as const);

export const LambdaIamRole = lambdaIamRoleSchema.defineOperations({
  create: async (params) => {
    const command = new sdk.CreateRoleCommand(params);
    await iamClient.send(command);
  },
  read: async (key) => {
    const command = new sdk.GetRoleCommand(key);
    const { Role } = await iamClient.send(command);
    return Role!;
  },
  update: async (key, params) => {
    const command = new sdk.UpdateRoleCommand({ ...key, ...params });
    await iamClient.send(command);
  },
  delete: async (key) => {
    const command = new sdk.DeleteRoleCommand(key);
    await iamClient.send(command);
  },
  deriveParams: () => ({
    AssumeRolePolicyDocument: JSON.stringify(lambdaTrustPolicy),
  }),
});

export type LambdaIamRoleInstance = InstanceType<typeof LambdaIamRole>;
