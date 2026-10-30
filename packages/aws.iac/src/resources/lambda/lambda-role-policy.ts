import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import type { PolicyDocument, PolicyStatement } from "src/templates/iam.policy";

export type { PolicyDocument, PolicyStatement };

/**
 * An inline policy of a Lambda's role. The params hold the policy document
 * as a structured map, so diff and plan compare each statement. The provider
 * encodes it as JSON only in API calls.
 */
type LambdaRolePolicyParams = Omit<
  sdk.PutRolePolicyRequest,
  "PolicyDocument"
> & {
  PolicyDocument: PolicyDocument;
};

export type LambdaRolePolicySchema = AwsSchema<{
  Key: sdk.DeleteRolePolicyRequest;
  CreateParams: LambdaRolePolicyParams;
  ReadResult: LambdaRolePolicyParams;
}>;

const lambdaRolePolicy = resource<LambdaRolePolicySchema>({
  type: "aws/lambda/LambdaRolePolicy",
});

const lambdaRolePolicySchema = lambdaRolePolicy.defineSchema({
  RoleName: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  PolicyName: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
  },
  PolicyDocument: {
    propertyType: "param",
    presence: "required",
    // Statements are concatenated in the order the engine sorts them into,
    // so the document does not depend on the order code ran in.
    collect: (items) => ({
      Version: "2012-10-17",
      Statement: items.flatMap(
        (item) => (item.Statement ?? []) as PolicyStatement[],
      ),
    }),
  },
} as const);

export const LambdaRolePolicy = lambdaRolePolicySchema.defineOperations({
  create: async (params) => {
    await putRolePolicy(params);
  },
  read: async (key) => {
    try {
      const result = await iamClient.send(new sdk.GetRolePolicyCommand(key));
      return {
        RoleName: result.RoleName!,
        PolicyName: result.PolicyName!,
        PolicyDocument: decodePolicyDocument(result.PolicyDocument!),
      };
    } catch (error) {
      if (error instanceof sdk.NoSuchEntityException) {
        throw new ResourceNotFoundError("Lambda role policy was not found", {
          cause: error,
        });
      }
      throw error;
    }
  },
  // PutRolePolicy replaces the whole document, so a removed statement is
  // removed from AWS too.
  update: async (key, _patch, params) => {
    await putRolePolicy({ ...params, ...key });
  },
  delete: async (key) => {
    try {
      await iamClient.send(new sdk.DeleteRolePolicyCommand(key));
    } catch (error) {
      if (!(error instanceof sdk.NoSuchEntityException)) throw error;
    }
  },
});

export type LambdaRolePolicyInstance = InstanceType<typeof LambdaRolePolicy>;

// IAM rejects a document with no statements as malformed, without naming the
// policy, so this throws a clearer error first.
async function putRolePolicy(params: LambdaRolePolicyParams) {
  if (params.PolicyDocument.Statement.length === 0) {
    throw new Error(
      `Role policy ${params.PolicyName} has no statements. IAM does not accept an empty policy document.`,
    );
  }
  await iamClient.send(
    new sdk.PutRolePolicyCommand({
      ...params,
      PolicyDocument: JSON.stringify(params.PolicyDocument),
    }),
  );
}

/** IAM returns policy documents URL-encoded (RFC 3986). */
function decodePolicyDocument(document: string): PolicyDocument {
  return JSON.parse(decodeURIComponent(document));
}
