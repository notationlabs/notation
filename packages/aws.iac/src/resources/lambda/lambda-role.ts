import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import { pickDeclared } from "src/utils/read-result";
import { lambdaTrustPolicy } from "src/templates/iam.policy";

export type LambdaIamRoleSchema = AwsSchema<{
  Key: sdk.DeleteRoleRequest;
  CreateParams: sdk.CreateRoleRequest;
  UpdateParams: sdk.UpdateRoleRequest;
  ReadResult: LambdaIamRoleReadResult;
}>;

/**
 * The role as GetRole reports it, with each param in the shape it is
 * configured in, so a read can be compared with params. Dates are ISO 8601
 * strings, because the reconciler cannot record a Date.
 */
type LambdaIamRoleReadResult = Omit<
  sdk.Role,
  | "AssumeRolePolicyDocument"
  | "PermissionsBoundary"
  | "CreateDate"
  | "RoleLastUsed"
> & {
  AssumeRolePolicyDocument?: string;
  PermissionsBoundary?: string;
  CreateDate?: string;
  RoleLastUsed?: { LastUsedDate?: string; Region?: string };
};

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
    try {
      const command = new sdk.GetRoleCommand(key);
      const { Role } = await iamClient.send(command);
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
    await iamClient.send(command);
  },
  delete: async (key) => {
    try {
      const command = new sdk.DeleteRoleCommand(key);
      await iamClient.send(command);
    } catch (error) {
      if (!(error instanceof sdk.NoSuchEntityException)) throw error;
    }
  },
  deriveParams: () => ({
    AssumeRolePolicyDocument: JSON.stringify(lambdaTrustPolicy),
  }),
});

function toReadResult(role: sdk.Role): LambdaIamRoleReadResult {
  const {
    AssumeRolePolicyDocument,
    PermissionsBoundary,
    CreateDate,
    RoleLastUsed,
  } = role;
  return {
    ...pickDeclared(lambdaIamRoleSchema.schema, role),
    AssumeRolePolicyDocument:
      AssumeRolePolicyDocument === undefined
        ? undefined
        : decodePolicyDocument(AssumeRolePolicyDocument),
    PermissionsBoundary: PermissionsBoundary?.PermissionsBoundaryArn,
    CreateDate: CreateDate?.toISOString(),
    RoleLastUsed: RoleLastUsed && {
      ...RoleLastUsed,
      LastUsedDate: RoleLastUsed.LastUsedDate?.toISOString(),
    },
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
