import { AwsSchema } from "src/utils/types";
import * as sdk from "@aws-sdk/client-lambda";
import { LambdaFunctionInstance } from "../lambda";
import { EventBridgeRuleInstance } from "./rule";
import { resource } from "@notation/resource";
import z from "zod";
import { lambdaClient } from "src/utils/aws-clients";

// TODO: much of the lambda permission types can be shared between event-bridge and api-gateway (other than the dependencies part):
// move to a shared module?

export type LambdaEventBridgeRulePermissionSchema = AwsSchema<{
  Key: sdk.RemovePermissionRequest;
  CreateParams: sdk.AddPermissionRequest;
}>;

export type LambdaEventBridgeRulePermissionDependencies = {
  lambda: LambdaFunctionInstance;
  eventBridgeRule: EventBridgeRuleInstance;
};

const lambdaEventBridgeRulePermission =
  resource<LambdaEventBridgeRulePermissionSchema>({
    type: "aws/eventBridge/LambdaEventBridgeRulePermission",
  });

const LambdaEventBridgeRulePermissionSchema =
  lambdaEventBridgeRulePermission.defineSchema({
    FunctionName: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
      primaryKey: true,
    },
    StatementId: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
      secondaryKey: true,
    },
    Qualifier: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    RevisionId: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    Action: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
    },
    Principal: {
      valueType: z.string(),
      propertyType: "param",
      presence: "required",
    },
    FunctionUrlAuthType: {
      valueType: z.enum(["NONE", "AWS_IAM"]),
      propertyType: "param",
      presence: "optional",
    },
    InvocationType: {
      valueType: z.enum(["Event", "RequestResponse", "DryRun"]),
      propertyType: "param",
      presence: "optional",
    },
    Policy: {
      valueType: z.string(),
      propertyType: "computed",
      presence: "optional",
    },
    PrincipalOrgID: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
    },
    SourceArn: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
    },
    EventSourceToken: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
    },
    SourceAccount: {
      valueType: z.string(),
      propertyType: "param",
      presence: "optional",
    },
    // Todo: why does this solve the compile error at the top level?
  } as const);

export const LambdaEventBridgeRulePermission =
  LambdaEventBridgeRulePermissionSchema.defineOperations({
    create: async (params) => {
      const command = new sdk.AddPermissionCommand(params);
      await lambdaClient.send(command);
    },
    delete: async (key) => {
      const command = new sdk.RemovePermissionCommand(key);
      await lambdaClient.send(command);
    },
  })
    .requireDependencies<LambdaEventBridgeRulePermissionDependencies>()
    .deriveParams(async ({ deps }) => {
      return {
        FunctionName: deps.lambda.output.FunctionName,
        StatementId: `LambdaEventBridgeRulePermission-${deps.lambda.output.FunctionName}`,
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: deps.eventBridgeRule.output.Arn,
      };
    });

export type LambdaEventBridgeRulePermissionInstance = InstanceType<
  typeof LambdaEventBridgeRulePermission
>;
