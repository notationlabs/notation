import * as v from "valibot";
import { AwsSchema } from "src/utils/types";
import * as sdk from "@aws-sdk/client-lambda";
import { LambdaFunctionInstance } from "../lambda";
import { EventBridgeRuleInstance } from "./rule";
import { resource } from "@notation/resource";
import { lambdaClient } from "src/utils/aws-clients";
import { statementId } from "src/utils/statement-id";

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
      propertyType: "param",
      presence: "required",
      primaryKey: true,
      value: v.string(),
    },
    StatementId: {
      propertyType: "param",
      presence: "required",
      secondaryKey: true,
      value: v.string(),
    },
    Qualifier: {
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
      value: v.string(),
    },
    RevisionId: {
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
    FunctionUrlAuthType: {
      propertyType: "param",
      presence: "optional",
      value: v.enum(sdk.FunctionUrlAuthType),
    },
    Policy: {
      propertyType: "computed",
      presence: "optional",
      value: v.string(),
    },
    PrincipalOrgID: {
      propertyType: "param",
      presence: "optional",
      value: v.string(),
    },
    SourceArn: {
      propertyType: "param",
      presence: "optional",
      value: v.string(),
    },
    EventSourceToken: {
      propertyType: "param",
      presence: "optional",
      value: v.string(),
    },
    SourceAccount: {
      propertyType: "param",
      presence: "optional",
      value: v.string(),
    },
    // Todo: why does this solve the compile error at the top level?
  } as const);

export const LambdaEventBridgeRulePermission =
  LambdaEventBridgeRulePermissionSchema.defineOperations({
    create: async (params) => {
      const command = new sdk.AddPermissionCommand(params);
      await lambdaClient().send(command);
    },
    delete: async (key) => {
      const command = new sdk.RemovePermissionCommand(key);
      await lambdaClient().send(command);
    },
  })
    .requireDependencies<LambdaEventBridgeRulePermissionDependencies>()
    .deriveParams(async ({ deps }) => {
      return {
        FunctionName: deps.lambda.output.FunctionName,
        // One statement per rule, as several rules can invoke one function.
        StatementId: statementId("events", deps.eventBridgeRule.output.Name),
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
        SourceArn: deps.eventBridgeRule.output.Arn,
      };
    });

export type LambdaEventBridgeRulePermissionInstance = InstanceType<
  typeof LambdaEventBridgeRulePermission
>;
