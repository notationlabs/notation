import * as v from "valibot";
import { resource } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/resources/utils/aws-clients";
import { AwsSchema } from "src/resources/utils/types";
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
  provider: "@notation/aws/resources",
});

const lambdaRolePolicyAttachmentSchema =
  lambdaRolePolicyAttachment.defineSchema({
    RoleName: {
      propertyType: "param",
      presence: "required",
      value: v.string(),
      primaryKey: true,
    },
    PolicyArn: {
      propertyType: "param",
      presence: "required",
      value: v.string(),
      secondaryKey: true,
    },
  } as const);

export const LambdaRolePolicyAttachment = lambdaRolePolicyAttachmentSchema
  .defineOperations({
    create: async (params) => {
      const command = new sdk.AttachRolePolicyCommand(params);
      await iamClient().send(command);
    },
    delete: async (key) => {
      const command = new sdk.DetachRolePolicyCommand(key);
      await iamClient().send(command);
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
