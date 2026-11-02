import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-iam";
import { iamClient } from "src/utils/aws-clients";
import { AwsSchema } from "src/utils/types";
import type { PolicyDocument, PolicyStatement } from "src/templates/iam.policy";
import type { LambdaIamRoleInstance } from "./lambda-role";

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

export type LambdaRolePolicyDependencies = {
  role: LambdaIamRoleInstance;
};

export type LambdaRolePolicySchema = AwsSchema<{
  Key: sdk.DeleteRolePolicyRequest;
  CreateParams: LambdaRolePolicyParams;
  ReadResult: LambdaRolePolicyParams;
}>;

const stringOrStrings = v.union([v.string(), v.array(v.string())]);

const principalValue = v.union([
  v.literal("*"),
  v.record(v.string(), stringOrStrings),
]);

const conditionValue = v.union([v.string(), v.number(), v.boolean()]);

// Accepts the IAM policy grammar, since a read returns whatever document IAM
// holds, including one edited outside Notation.
const policyStatementValue = v.intersect([
  v.object({
    Sid: v.optional(v.string()),
    Effect: v.picklist(["Allow", "Deny"]),
    Principal: v.optional(principalValue),
    NotPrincipal: v.optional(principalValue),
    Condition: v.optional(
      v.record(
        v.string(),
        v.record(v.string(), v.union([conditionValue, v.array(conditionValue)])),
      ),
    ),
  }),
  v.union([
    v.object({ Action: stringOrStrings }),
    v.object({ NotAction: stringOrStrings }),
  ]),
  v.union([
    v.object({ Resource: stringOrStrings }),
    v.object({ NotResource: stringOrStrings }),
  ]),
]);

const policyDocumentValue = v.object({
  Version: v.optional(v.picklist(["2012-10-17", "2008-10-17"])),
  Id: v.optional(v.string()),
  Statement: v.array(policyStatementValue),
});

const lambdaRolePolicy = resource<LambdaRolePolicySchema>({
  type: "aws/lambda/LambdaRolePolicy",
});

const lambdaRolePolicySchema = lambdaRolePolicy.defineSchema({
  RoleName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    primaryKey: true,
  },
  PolicyName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    secondaryKey: true,
  },
  PolicyDocument: {
    propertyType: "param",
    presence: "required",
    value: policyDocumentValue,
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

// RoleName is config rather than derived from the role's output, so a plan
// knows the primary key before the role is deployed.
export const LambdaRolePolicy = lambdaRolePolicySchema
  .defineOperations({
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
  })
  .requireDependencies<LambdaRolePolicyDependencies>()
  .deriveParams(() => ({}));

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

/**
 * IAM returns policy documents URL-encoded (RFC 3986). A single statement
 * object is put in an array, so it compares equal to the same statement in
 * config.
 */
function decodePolicyDocument(document: string): PolicyDocument {
  const decoded = JSON.parse(decodeURIComponent(document));
  if (decoded?.Statement && !Array.isArray(decoded.Statement)) {
    decoded.Statement = [decoded.Statement];
  }
  return decoded;
}
