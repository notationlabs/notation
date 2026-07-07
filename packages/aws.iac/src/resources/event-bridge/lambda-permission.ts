import { AwsSchema } from "src/utils/types";
import * as sdk from "@aws-sdk/client-lambda";
import { LambdaFunctionInstance } from "../lambda";
import { EventBridgeRuleInstance } from "./rule";
import { resource, typed } from "@notation/resource";
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
      propertyType: "param",
      presence: "required",
      primaryKey: true,
    },
    StatementId: {
      propertyType: "param",
      presence: "required",
      secondaryKey: true,
    },
    Qualifier: {
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    RevisionId: {
      propertyType: "param",
      presence: "optional",
      secondaryKey: true,
    },
    Action: {
      propertyType: "param",
      presence: "required",
    },
    Principal: {
      propertyType: "param",
      presence: "required",
    },
    FunctionUrlAuthType: {
      propertyType: "param",
      presence: "optional",
    },
    InvocationType: {
      propertyType: "param",
      presence: "optional",
    },
    Policy: {
      valueType: typed<string>(),
      propertyType: "computed",
      presence: "optional",
    },
    PrincipalOrgID: {
      propertyType: "param",
      presence: "optional",
    },
    SourceArn: {
      propertyType: "param",
      presence: "optional",
    },
    EventSourceToken: {
      propertyType: "param",
      presence: "optional",
    },
    SourceAccount: {
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
