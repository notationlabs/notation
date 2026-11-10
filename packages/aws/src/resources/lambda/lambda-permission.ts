import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { awsCreate } from "src/resources/utils/errors";
import { AwsSchema } from "src/resources/utils/types";
import { statementId } from "src/resources/utils/statement-id";
import type { LambdaFunctionInstance } from "./lambda";

type LambdaPermissionKey = {
  FunctionName: string;
  StatementId: string;
};

type LambdaPermissionParams = LambdaPermissionKey & {
  /** The action the principal may take, such as `lambda:InvokeFunction`. */
  Action: string;
  /**
   * The service that may invoke the function, such as `events.amazonaws.com`.
   * AddPermission also takes an account ID or `*`, but `LambdaPermission`
   * only takes a service, as `read` finds the principal under `Service`.
   */
  Principal: string;
  /**
   * The ARN of the resource that may invoke the function. Without it, a
   * service principal may invoke the function on behalf of any account.
   */
  SourceArn?: string;
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
  provider: "@notation/aws/resources",
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
  Action: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  Principal: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(
      v.string(),
      v.regex(
        /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
        "Principal must be a service, such as events.amazonaws.com",
      ),
    ),
  },
  SourceArn: {
    propertyType: "param",
    presence: "optional",
    value: v.string(),
  },
} as const);

/**
 * A statement in a Lambda function's resource policy, which lets a service
 * invoke the function. Its params follow Lambda's AddPermission, with a
 * service as the only kind of principal.
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
        Action: statement.Action,
        Principal: statement.Principal.Service,
        SourceArn: statement.Condition?.ArnLike?.["AWS:SourceArn"],
      };
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
  Principal: { Service: string };
  Condition?: { ArnLike?: Record<string, string> };
};

async function findStatement(
  key: LambdaPermissionKey,
): Promise<PolicyStatement | undefined> {
  try {
    const { Policy } = await lambdaClient().send(
      new sdk.GetPolicyCommand({ FunctionName: key.FunctionName }),
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
