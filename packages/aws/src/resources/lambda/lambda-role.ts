import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/resources/utils/aws-clients";
import { awsCreate } from "src/resources/utils/errors";
import { AwsSchema } from "src/resources/utils/types";
import { lambdaTrustPolicy } from "src/resources/templates/iam.policy";

export type LambdaIamRoleSchema = AwsSchema<{
  Key: sdk.DeleteRoleRequest;
  CreateParams: sdk.CreateRoleRequest;
  UpdateParams: sdk.UpdateRoleRequest;
  ReadResult: LambdaIamRoleReadResult;
}>;

/**
 * The role as GetRole reports it, with each param in the shape it is
 * configured in, so a read can be compared with params.
 */
type LambdaIamRoleReadResult = Omit<
  sdk.Role,
  "AssumeRolePolicyDocument" | "PermissionsBoundary"
> & {
  AssumeRolePolicyDocument?: string;
  PermissionsBoundary?: string;
};

const lambdaIamRole = resource<LambdaIamRoleSchema>({
  type: "aws/lambda/LambdaIamRole",
  provider: "@notation/aws/resources",
});

const lambdaIamRoleSchema = lambdaIamRole.defineSchema({
  RoleName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    primaryKey: true,
  },
  Arn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  AssumeRolePolicyDocument: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    immutable: true,
  },
  CreateDate: {
    propertyType: "computed",
    presence: "required",
    value: v.date(),
    volatile: true,
  },
  Description: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  MaxSessionDuration: {
    propertyType: "param",
    presence: "optional",
    value: v.number(),
  },
  Path: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
    immutable: true,
  },
  PermissionsBoundary: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
    immutable: true,
  },
  RoleId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  RoleLastUsed: {
    propertyType: "computed",
    presence: "optional",
    value: v.object({
      LastUsedDate: v.optional(v.date()),
      Region: v.optional(v.string()),
    }),
  },
} as const);

export const LambdaIamRole = lambdaIamRoleSchema.defineOperations({
  create: awsCreate(
    async (params) => {
      const command = new sdk.CreateRoleCommand(params);
      await iamClient().send(command);
    },
    {
      alreadyExists: (error) =>
        error instanceof sdk.EntityAlreadyExistsException,
    },
  ),
  read: async (key) => {
    try {
      const command = new sdk.GetRoleCommand(key);
      const { Role } = await iamClient().send(command);
      return toReadResult(Role!);
    } catch (error) {
      if (error instanceof sdk.NoSuchEntityException) {
        throw new ResourceNotFoundError("Lambda IAM role was not found", {
          cause: error,
        });
      }
      throw error;
    }
  },
  update: async (key, params) => {
    const command = new sdk.UpdateRoleCommand({ ...key, ...params });
    await iamClient().send(command);
  },
  delete: async (key) => {
    try {
      const command = new sdk.DeleteRoleCommand(key);
      await iamClient().send(command);
    } catch (error) {
      if (!(error instanceof sdk.NoSuchEntityException)) throw error;
    }
  },
  deriveParams: () => ({
    AssumeRolePolicyDocument: JSON.stringify(lambdaTrustPolicy),
  }),
});

function toReadResult(role: sdk.Role): LambdaIamRoleReadResult {
  const { AssumeRolePolicyDocument, PermissionsBoundary, ...rest } = role;
  return {
    ...rest,
    AssumeRolePolicyDocument:
      AssumeRolePolicyDocument === undefined
        ? undefined
        : decodePolicyDocument(AssumeRolePolicyDocument),
    PermissionsBoundary: PermissionsBoundary?.PermissionsBoundaryArn,
  };
}

/**
 * IAM returns policy documents URL-encoded (RFC 3986). Decodes one and
 * re-serialises it compactly, the form the trust policy param is built in.
 */
function decodePolicyDocument(document: string): string {
  const decoded = decodeURIComponent(document);
  try {
    return JSON.stringify(JSON.parse(decoded));
  } catch {
    return decoded;
  }
}

export type LambdaIamRoleInstance = InstanceType<typeof LambdaIamRole>;
