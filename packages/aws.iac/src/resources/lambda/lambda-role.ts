import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import * as z from "zod";
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
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  Arn: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
  },
  AssumeRolePolicyDocument: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
  },
  CreateDate: {
    valueType: z.date(),
    propertyType: "computed",
    presence: "required",
    volatile: true,
  },
  Description: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  MaxSessionDuration: {
    valueType: z.number(),
    propertyType: "param",
    presence: "optional",
  },
  Path: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  PermissionsBoundary: {
    valueType: z.string(),
    propertyType: "param",
    presence: "optional",
  },
  RoleId: {
    valueType: z.string(),
    propertyType: "computed",
    presence: "required",
  },
  RoleLastUsed: {
    valueType: z.object({
      LastUsedDate: z.date().optional(),
      Region: z.string().optional(),
    }),
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
