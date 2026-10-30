import { resource, ResourceNotFoundError } from "@notation/resource";
import { AwsSchema } from "src/utils/types";
import { pickDeclared } from "src/utils/read-result";
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

type TargetsResult = {
  FailedEntryCount?: number;
  FailedEntries?: {
    TargetId?: string;
    ErrorCode?: string;
    ErrorMessage?: string;
  }[];
};

// PutTargets and RemoveTargets report per-target failures in the response
// rather than throwing, so a partially failed call has to be detected here.
function assertNoFailedTargets(
  action: string,
  rule: string | undefined,
  result: TargetsResult,
) {
  const failed = result.FailedEntries ?? [];
  if (!result.FailedEntryCount && failed.length === 0) return;

  const details = failed
    .map(
      (entry) =>
        `  - ${entry.TargetId ?? "(unknown target)"}: ${entry.ErrorCode ?? "UnknownError"}${entry.ErrorMessage ? ` - ${entry.ErrorMessage}` : ""}`,
    )
    .join("\n");
  const count = result.FailedEntryCount || failed.length;

  throw new Error(
    `Failed to ${action} ${count} target(s) on EventBridge rule "${rule}"` +
      (details ? `:\n${details}` : ""),
  );
}

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
      try {
        const describeRuleCommand = new sdk.DescribeRuleCommand(key);
        const listRuleTargetsCommand = new sdk.ListTargetsByRuleCommand({
          Rule: key.Name,
          EventBusName: key.EventBusName,
        });

        const [ruleDescriptionResult, listRuleTargetsResult] =
          await Promise.all([
            eventBridgeClient.send(describeRuleCommand),
            eventBridgeClient.send(listRuleTargetsCommand),
          ]);

        return pickDeclared(eventBridgeRuleSchema.schema, {
          ...ruleDescriptionResult,
          ...listRuleTargetsResult,
        });
      } catch (error) {
        if (error instanceof sdk.ResourceNotFoundException) {
          throw new ResourceNotFoundError("EventBridge rule was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },

    create: async (params) => {
      const createRuleCommand = new sdk.PutRuleCommand(params);
      const createTargetsCommand = new sdk.PutTargetsCommand({
        Rule: params.Name,
        EventBusName: params.EventBusName,
        Targets: params.Targets,
      });

      await eventBridgeClient.send(createRuleCommand);
      assertNoFailedTargets(
        "put",
        params.Name,
        await eventBridgeClient.send(createTargetsCommand),
      );
    },
    update: async (key, patch, params) => {
      // PutRule replaces the rule's settings, so it is sent the whole rule,
      // not just the changed fields.
      const { Targets, ...ruleConfig } = params;

      const updateRuleCommand = new sdk.PutRuleCommand(ruleConfig);
      await eventBridgeClient.send(updateRuleCommand);

      // PutTargets only adds or replaces targets, so any target no longer in
      // config has to be removed explicitly. The rule's current targets are
      // listed rather than taken from state, so targets added outside of
      // Notation are removed too.
      const existingTargets = await eventBridgeClient.send(
        new sdk.ListTargetsByRuleCommand({
          Rule: ruleConfig.Name,
          EventBusName: ruleConfig.EventBusName,
        }),
      );

      const desiredTargetIds = new Set(Targets?.map((target) => target.Id));
      const staleTargetIds = (existingTargets.Targets ?? [])
        .map((target) => target.Id!)
        .filter((id) => !desiredTargetIds.has(id));

      // Stale targets are removed first so that swapping targets never takes
      // the rule over its target limit.
      if (staleTargetIds.length > 0) {
        const removeTargetsCommand = new sdk.RemoveTargetsCommand({
          Rule: ruleConfig.Name,
          EventBusName: ruleConfig.EventBusName,
          Ids: staleTargetIds,
        });
        assertNoFailedTargets(
          "remove",
          ruleConfig.Name,
          await eventBridgeClient.send(removeTargetsCommand),
        );
      }

      if (Targets && Targets.length > 0) {
        const updateTargetsCommand = new sdk.PutTargetsCommand({
          Rule: ruleConfig.Name,
          EventBusName: ruleConfig.EventBusName,
          Targets: Targets,
        });
        assertNoFailedTargets(
          "put",
          ruleConfig.Name,
          await eventBridgeClient.send(updateTargetsCommand),
        );
      }
    },
    delete: async (key) => {
      try {
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

          assertNoFailedTargets(
            "remove",
            key.Name,
            await eventBridgeClient.send(deleteTargetsCommand),
          );
        }

        const deleteRuleCommand = new sdk.DeleteRuleCommand(key);
        await eventBridgeClient.send(deleteRuleCommand);
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
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
