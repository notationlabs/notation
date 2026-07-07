import { resource } from "@notation/resource";
import { AwsSchema } from "src/utils/types";
import * as sdk from "@aws-sdk/client-eventbridge";
import { eventBridgeClient } from "src/utils/aws-clients";
import { LambdaFunctionInstance } from "../lambda";

export type EventBridgeRuleSchema = AwsSchema<{
  Key: sdk.DescribeRuleCommandInput;
  // We omit the 'Rule' field since this is just an alias of the 'Name' field
  CreateParams: sdk.PutRuleCommandInput &
    Omit<sdk.PutTargetsCommandInput, "Rule">;
  UpdateParams: sdk.PutRuleCommandInput &
    Omit<sdk.PutTargetsCommandInput, "Rule">;
  ReadResult: Omit<
    sdk.DescribeRuleCommandOutput & sdk.ListTargetsByRuleCommandOutput,
    "$metadata"
  >;
}>;

export type EventBridgeRuleDependencies = {
  lambda: LambdaFunctionInstance;
};

const eventBridgeRule = resource<EventBridgeRuleSchema>({
  type: "aws/eventBridge/rule",
});

const eventBridgeRuleSchema = eventBridgeRule.defineSchema({
  Name: {
    presence: "required",
    primaryKey: true,
    propertyType: "param",
  },
  EventBusName: {
    presence: "required",
    defaultValue: "default",
    propertyType: "param",
    secondaryKey: true,
  },
  ScheduleExpression: {
    presence: "optional",
    propertyType: "param",
  },
  EventPattern: {
    // Note: this is a JSON string representation of an event pattern:
    // (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html#eb-filtering-data-types)
    presence: "optional",
    propertyType: "param",
  },
  Targets: {
    presence: "required",
    propertyType: "param",
  },
  Arn: {
    presence: "required",
    propertyType: "computed",
  },
});

export const EventBridgeRule = eventBridgeRuleSchema
  .defineOperations({
    read: async (key) => {
      const describeRuleCommand = new sdk.DescribeRuleCommand(key);
      const listRuleTargetsCommand = new sdk.ListTargetsByRuleCommand({
        Rule: key.Name,
        EventBusName: key.EventBusName,
      });

      const [ruleDescriptionResult, listRuleTargetsResult] = await Promise.all([
        eventBridgeClient.send(describeRuleCommand),
        eventBridgeClient.send(listRuleTargetsCommand),
      ]);

      return {
        ...ruleDescriptionResult,
        ...listRuleTargetsResult,
      };
    },

    create: async (params) => {
      const createRuleCommand = new sdk.PutRuleCommand(params);
      const createTargetsCommand = new sdk.PutTargetsCommand({
        Rule: params.Name,
        EventBusName: params.EventBusName,
        Targets: params.Targets,
      });

      await eventBridgeClient.send(createRuleCommand);
      await eventBridgeClient.send(createTargetsCommand);
    },
    update: async (key, patch, params) => {
      const { Targets, ...ruleConfig } = patch;

      const updateRuleCommand = new sdk.PutRuleCommand(ruleConfig);
      const updateTargetsCommand = new sdk.PutTargetsCommand({
        Rule: ruleConfig.Name,
        EventBusName: ruleConfig.EventBusName,
        Targets: Targets,
      });

      await eventBridgeClient.send(updateRuleCommand);
      await eventBridgeClient.send(updateTargetsCommand);
    },
    delete: async (key) => {
      // The targets must be deleted first, otherwise the API will return an error response

      const existingTargets = await eventBridgeClient.send(
        new sdk.ListTargetsByRuleCommand({
          Rule: key.Name,
          EventBusName: key.EventBusName,
        }),
      );

      if (existingTargets.Targets && existingTargets.Targets.length > 0) {
        const deleteTargetsCommand = new sdk.RemoveTargetsCommand({
          Rule: key.Name,
          EventBusName: key.EventBusName,
          Ids: existingTargets.Targets.map((target) => target.Id!),
        });

        await eventBridgeClient.send(deleteTargetsCommand);
      }

      const deleteRuleCommand = new sdk.DeleteRuleCommand(key);
      await eventBridgeClient.send(deleteRuleCommand);
    },
  })
  .requireDependencies<EventBridgeRuleDependencies>()
  .deriveParams(async ({ deps }) => ({
    Targets: [
      {
        Id: deps.lambda.output.FunctionName,
        Arn: deps.lambda.output.FunctionArn,
      },
    ],
  }));

export type EventBridgeRuleInstance = InstanceType<typeof EventBridgeRule>;
