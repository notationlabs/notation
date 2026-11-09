import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { awsCreate } from "src/utils/errors";
import { AwsSchema } from "src/utils/types";
import type { LambdaFunctionInstance } from "./lambda";

type LambdaPermissionKey = {
  FunctionName: string;
  StatementId: string;
  Qualifier?: string;
};

type LambdaPermissionParams = LambdaPermissionKey & {
  Action: string;
  /** The service that may invoke the function, such as `events.amazonaws.com`. */
  Principal: string;
  /** The ARN of the resource that may invoke the function. */
  SourceArn: string;
  /** The account that owns the source. S3 needs it, as a bucket ARN has no account. */
  SourceAccount?: string;
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
  // Required, as a service principal without a source lets the service
  // invoke the function on behalf of any account.
  SourceArn: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  SourceAccount: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(v.string(), v.regex(/^\d{12}$/)),
  },
} as const);

/**
 * A statement in a Lambda function's resource policy, which lets a service
 * such as API Gateway or EventBridge invoke the function. The caller chooses
 * `StatementId`, which must be unique among the function's statements.
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
        Principal: statement.Principal?.Service ?? statement.Principal?.AWS,
        SourceArn: statement.Condition?.ArnLike?.["AWS:SourceArn"],
        SourceAccount: statement.Condition?.StringEquals?.["AWS:SourceAccount"],
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
  .deriveParams(({ deps }) => ({
    FunctionName: deps.lambda.output.FunctionName,
    Action: "lambda:InvokeFunction",
  }));

export type LambdaPermissionInstance = InstanceType<typeof LambdaPermission>;

type PolicyStatement = {
  Sid: string;
  Action: string;
  Principal?: { Service?: string; AWS?: string };
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
