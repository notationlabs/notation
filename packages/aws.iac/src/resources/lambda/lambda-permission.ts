import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { awsCreate } from "src/utils/errors";
import { AwsSchema } from "src/utils/types";
import { statementId } from "src/utils/statement-id";
import type { LambdaFunctionInstance } from "./lambda";

type LambdaPermissionKey = {
  FunctionName: string;
  StatementId: string;
  Qualifier?: string;
};

type LambdaPermissionParams = LambdaPermissionKey & {
  /** The action the principal may take, such as `lambda:InvokeFunction`. */
  Action: string;
  /**
   * The service or account that may invoke the function, such as
   * `events.amazonaws.com`.
   */
  Principal: string;
  /**
   * The ARN of the resource that may invoke the function. Without it, a
   * service principal may invoke the function on behalf of any account.
   */
  SourceArn?: string;
  /** The account that owns the source. S3 needs it, as a bucket ARN has no account. */
  SourceAccount?: string;
  /** The auth type of the function URL, for a permission to call one. */
  FunctionUrlAuthType?: sdk.FunctionUrlAuthType;
};

export type LambdaPermissionSchema = AwsSchema<{
  Key: LambdaPermissionKey;
  CreateParams: LambdaPermissionParams;
  ReadResult: LambdaPermissionParams;
}>;

export type LambdaPermissionDependencies = {
  lambda: LambdaFunctionInstance;
};

const lambdaPermission = resource<LambdaPermissionSchema>({
  type: "aws/lambda/LambdaPermission",
  provider: "@notation/aws.iac",
});

const lambdaPermissionSchema = lambdaPermission.defineSchema({
  FunctionName: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  StatementId: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
    value: v.pipe(v.string(), v.regex(/^[0-9A-Za-z_-]{1,100}$/)),
  },
  Qualifier: {
    propertyType: "param",
    presence: "optional",
    secondaryKey: true,
    value: v.string(),
  },
  Action: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  Principal: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  SourceArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
  SourceAccount: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(v.string(), v.regex(/^\d{12}$/)),
  },
  FunctionUrlAuthType: {
    propertyType: "param",
    presence: "optional",
    value: v.enum(sdk.FunctionUrlAuthType),
  },
} as const);

/**
 * A statement in a Lambda function's resource policy, which lets a service
 * or account invoke the function. Its params follow Lambda's AddPermission.
 * The `StatementId` is made from the resource ID, so it is unique among the
 * function's statements while resource IDs are unique.
 */
export const LambdaPermission = lambdaPermissionSchema
  .defineOperations({
    // AddPermission fails when the StatementId exists, so a create whose
    // outcome is unknown is found by `read`, whose key is made of params.
    create: awsCreate(async (params) => {
      await lambdaClient().send(new sdk.AddPermissionCommand(params));
    }),
    read: async (key) => {
      const statement = await findStatement(key);
      if (!statement) {
        throw new ResourceNotFoundError(
          `The policy of ${key.FunctionName} has no statement ${key.StatementId}`,
        );
      }
      return {
        FunctionName: key.FunctionName,
        StatementId: key.StatementId,
        Qualifier: key.Qualifier,
        Action: statement.Action,
        Principal:
          typeof statement.Principal === "string"
            ? statement.Principal
            : (statement.Principal?.Service ?? statement.Principal?.AWS),
        SourceArn: statement.Condition?.ArnLike?.["AWS:SourceArn"],
        SourceAccount: statement.Condition?.StringEquals?.["AWS:SourceAccount"],
        FunctionUrlAuthType:
          statement.Condition?.StringEquals?.["lambda:FunctionUrlAuthType"],
      } as LambdaPermissionSchema["ReadResult"];
    },
    delete: async (key) => {
      try {
        await lambdaClient().send(new sdk.RemovePermissionCommand(key));
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<LambdaPermissionDependencies>()
  .deriveParams(({ id, deps }) => ({
    FunctionName: deps.lambda.output.FunctionName,
    StatementId: statementId(id),
  }));

export type LambdaPermissionInstance = InstanceType<typeof LambdaPermission>;

type PolicyStatement = {
  Sid: string;
  Action: string;
  Principal?: string | { Service?: string; AWS?: string };
  Condition?: {
    ArnLike?: Record<string, string>;
    StringEquals?: Record<string, string>;
  };
};

async function findStatement(
  key: LambdaPermissionKey,
): Promise<PolicyStatement | undefined> {
  try {
    const { Policy } = await lambdaClient().send(
      new sdk.GetPolicyCommand({
        FunctionName: key.FunctionName,
        Qualifier: key.Qualifier,
      }),
    );
    const statements: PolicyStatement[] = Policy
      ? JSON.parse(Policy).Statement
      : [];
    return statements.find((statement) => statement.Sid === key.StatementId);
  } catch (error) {
    // Lambda reports a function with no policy as not found, too.
    if (error instanceof sdk.ResourceNotFoundException) return undefined;
    throw error;
  }
}
