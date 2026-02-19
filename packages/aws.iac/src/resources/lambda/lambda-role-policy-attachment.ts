import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import * as z from "zod";
import { iamClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { LambdaIamRoleInstance } from ".";

export type LambdaRolePolicyAttachmentSchema = AwsSchema<{
  Key: sdk.DetachRolePolicyRequest;
  CreateParams: sdk.AttachRolePolicyRequest;
}>;

export type LambdaRolePolicyAttachmentDependencies = {
  role: LambdaIamRoleInstance;
};

const lambdaRolePolicyAttachment = resource<LambdaRolePolicyAttachmentSchema>({
  type: "aws/lambda/LambdaRolePolicyAttachment",
});

const lambdaRolePolicyAttachmentSchema =
  lambdaRolePolicyAttachment.defineSchema({
    RoleName: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
      primaryKey: true,
    },
    PolicyArn: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
      secondaryKey: true,
    },
  } as const);

export const LambdaRolePolicyAttachment = lambdaRolePolicyAttachmentSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.AttachRolePolicyCommand(params);
      await iamClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.DetachRolePolicyCommand(key);
      await iamClient.send(command);
    },
  })
  .requireDependencies<LambdaRolePolicyAttachmentDependencies>()
  .deriveParams(({ deps }) => ({
    RoleName: deps.role.output.RoleName,
    PolicyArn:
      "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  }));

export type LambdaRolePolicyAttachmentInstance = InstanceType<
  typeof LambdaRolePolicyAttachment
>;
