import * as v from "valibot";
import {
  resource,
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { AwsSchema } from "src/resources/utils/types";
import * as sdk from "@aws-sdk/client-eventbridge";
import { eventBridgeClient } from "src/resources/utils/aws-clients";
import { awsCreate } from "src/resources/utils/errors";
import { LambdaFunctionInstance } from "../lambda";
import {
  EventBus,
  type DefaultEventBusInstance,
  type EventBusInstance,
} from "./event-bus";

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
  // The rule's bus, so that the bus is made before the rule and deleted
  // after it. `EventBusName` holds the bus's name.
  eventBus?: EventBusInstance | DefaultEventBusInstance;
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
  provider: "@notation/aws/resources",
  // AWS refuses to delete a bus that has rules. The default bus is never
  // deleted, so it is not listed.
  blocksDeleteOf: [EventBus.type],
});

const keyValue = v.object({ Key: v.string(), Value: v.string() });

const ecsParameters = v.object({
  TaskDefinitionArn: v.string(),
  TaskCount: v.optional(v.number()),
  LaunchType: v.optional(v.enum(sdk.LaunchType)),
  NetworkConfiguration: v.optional(
    v.object({
      awsvpcConfiguration: v.optional(
        v.object({
          Subnets: v.array(v.string()),
          SecurityGroups: v.optional(v.array(v.string())),
          AssignPublicIp: v.optional(v.enum(sdk.AssignPublicIp)),
        }),
      ),
    }),
  ),
  PlatformVersion: v.optional(v.string()),
  Group: v.optional(v.string()),
  CapacityProviderStrategy: v.optional(
    v.array(
      v.object({
        capacityProvider: v.string(),
        weight: v.optional(v.number()),
        base: v.optional(v.number()),
      }),
    ),
  ),
  EnableECSManagedTags: v.optional(v.boolean()),
  EnableExecuteCommand: v.optional(v.boolean()),
  PlacementConstraints: v.optional(
    v.array(
      v.object({
        type: v.optional(v.enum(sdk.PlacementConstraintType)),
        expression: v.optional(v.string()),
      }),
    ),
  ),
  PlacementStrategy: v.optional(
    v.array(
      v.object({
        type: v.optional(v.enum(sdk.PlacementStrategyType)),
        field: v.optional(v.string()),
      }),
    ),
  ),
  PropagateTags: v.optional(v.enum(sdk.PropagateTags)),
  ReferenceId: v.optional(v.string()),
  Tags: v.optional(v.array(keyValue)),
});

const target = v.object({
  Id: v.string(),
  Arn: v.string(),
  RoleArn: v.optional(v.string()),
  Input: v.optional(v.string()),
  InputPath: v.optional(v.string()),
  InputTransformer: v.optional(
    v.object({
      InputPathsMap: v.optional(v.record(v.string(), v.string())),
      InputTemplate: v.string(),
    }),
  ),
  KinesisParameters: v.optional(v.object({ PartitionKeyPath: v.string() })),
  RunCommandParameters: v.optional(
    v.object({
      RunCommandTargets: v.array(
        v.object({ Key: v.string(), Values: v.array(v.string()) }),
      ),
    }),
  ),
  EcsParameters: v.optional(ecsParameters),
  BatchParameters: v.optional(
    v.object({
      JobDefinition: v.string(),
      JobName: v.string(),
      ArrayProperties: v.optional(v.object({ Size: v.optional(v.number()) })),
      RetryStrategy: v.optional(v.object({ Attempts: v.optional(v.number()) })),
    }),
  ),
  SqsParameters: v.optional(
    v.object({ MessageGroupId: v.optional(v.string()) }),
  ),
  HttpParameters: v.optional(
    v.object({
      PathParameterValues: v.optional(v.array(v.string())),
      HeaderParameters: v.optional(v.record(v.string(), v.string())),
      QueryStringParameters: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  RedshiftDataParameters: v.optional(
    v.object({
      SecretManagerArn: v.optional(v.string()),
      Database: v.string(),
      DbUser: v.optional(v.string()),
      Sql: v.optional(v.string()),
      StatementName: v.optional(v.string()),
      WithEvent: v.optional(v.boolean()),
      Sqls: v.optional(v.array(v.string())),
    }),
  ),
  SageMakerPipelineParameters: v.optional(
    v.object({
      PipelineParameterList: v.optional(
        v.array(v.object({ Name: v.string(), Value: v.string() })),
      ),
    }),
  ),
  DeadLetterConfig: v.optional(v.object({ Arn: v.optional(v.string()) })),
  RetryPolicy: v.optional(
    v.object({
      MaximumRetryAttempts: v.optional(v.number()),
      MaximumEventAgeInSeconds: v.optional(v.number()),
    }),
  ),
  AppSyncParameters: v.optional(
    v.object({ GraphQLOperation: v.optional(v.string()) }),
  ),
});

const eventBridgeRuleSchema = eventBridgeRule.defineSchema({
  Name: {
    presence: "required",
    primaryKey: true,
    propertyType: "param",
    value: v.string(),
  },
  EventBusName: {
    presence: "required",
    propertyType: "param",
    secondaryKey: true,
    value: v.string(),
  },
  ScheduleExpression: {
    presence: "optional",
    propertyType: "param",
    value: v.string(),
  },
  EventPattern: {
    // Note: this is a JSON string representation of an event pattern:
    // (https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html#eb-filtering-data-types)
    presence: "optional",
    propertyType: "param",
    value: v.string(),
  },
  State: {
    presence: "optional",
    propertyType: "param",
    value: v.enum(sdk.RuleState),
  },
  Targets: {
    presence: "required",
    propertyType: "param",
    value: v.array(target),
  },
  Arn: {
    presence: "required",
    propertyType: "computed",
    value: v.string(),
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
            eventBridgeClient().send(describeRuleCommand),
            eventBridgeClient().send(listRuleTargetsCommand),
          ]);

        const { EventPattern } = ruleDescriptionResult;
        return {
          ...ruleDescriptionResult,
          EventPattern: EventPattern && compactJson(EventPattern),
          ...listRuleTargetsResult,
        };
      } catch (error) {
        if (error instanceof sdk.ResourceNotFoundException) {
          throw new ResourceNotFoundError("EventBridge rule was not found", {
            cause: error,
          });
        }
        throw error;
      }
    },

    // PutRule overwrites an existing rule instead of failing, so create
    // checks for the rule first.
    create: awsCreate(async (params) => {
      const key = { Name: params.Name, EventBusName: params.EventBusName };
      if (await describeRule(key)) {
        throw new ResourceAlreadyExistsError(
          `EventBridge rule "${params.Name}" already exists`,
        );
      }
      const { Targets, ...ruleConfig } = params;
      await eventBridgeClient().send(new sdk.PutRuleCommand(ruleConfig));
      try {
        assertNoFailedTargets(
          "put",
          params.Name,
          await eventBridgeClient().send(
            new sdk.PutTargetsCommand({
              Rule: params.Name,
              EventBusName: params.EventBusName,
              Targets,
            }),
          ),
        );
      } catch (error) {
        // A rule kept without its targets would be found by the create's
        // lookup, and recorded with targets it does not have.
        await deleteCreatedRule(key, errorMessage(error));
      }
    }),
    update: async (key, patch, params) => {
      // PutRule replaces the rule's settings, so it is sent the whole rule,
      // not just the changed fields.
      const { Targets, ...ruleConfig } = params;

      const updateRuleCommand = new sdk.PutRuleCommand(ruleConfig);
      await eventBridgeClient().send(updateRuleCommand);

      // PutTargets only adds or replaces targets, so any target no longer in
      // config has to be removed explicitly. The rule's current targets are
      // listed rather than taken from state, so targets added outside of
      // Notation are removed too.
      const existingTargets = await eventBridgeClient().send(
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
          await eventBridgeClient().send(removeTargetsCommand),
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
          await eventBridgeClient().send(updateTargetsCommand),
        );
      }
    },
    delete: async (key) => deleteRule(key),
  })
  .requireDependencies<EventBridgeRuleDependencies>()
  .deriveParams(({ config }) => {
    // Typed as `{}`, because a param that deriveParams returns is removed
    // from the config type, and the pattern is set in config.
    const derived: {} =
      config.EventPattern === undefined
        ? {}
        : { EventPattern: compactJson(config.EventPattern) };
    return derived;
  });

/** Deletes the rule, then throws. */
async function deleteCreatedRule(
  key: sdk.DescribeRuleCommandInput,
  message: string,
): Promise<never> {
  try {
    await deleteRule(key);
  } catch (error) {
    throw new ResourceCreationUnknownError(
      `The targets of EventBridge rule "${key.Name}" were not put ` +
        `(${message}), and the rule could not be deleted: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  throw new Error(
    `The targets of EventBridge rule "${key.Name}" were not put, so the ` +
      `rule was deleted: ${message}`,
  );
}

async function describeRule(
  key: sdk.DescribeRuleCommandInput,
): Promise<sdk.DescribeRuleCommandOutput | undefined> {
  try {
    return await eventBridgeClient().send(new sdk.DescribeRuleCommand(key));
  } catch (error) {
    if (error instanceof sdk.ResourceNotFoundException) return undefined;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deleteRule(key: sdk.DescribeRuleCommandInput) {
  try {
    // The targets must be deleted first, otherwise the API will return an error response
    const existingTargets = await eventBridgeClient().send(
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
        await eventBridgeClient().send(deleteTargetsCommand),
      );
    }

    const deleteRuleCommand = new sdk.DeleteRuleCommand(key);
    await eventBridgeClient().send(deleteRuleCommand);
  } catch (error) {
    if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
  }
}

// The pattern is compared as a string, so the configured pattern and the
// pattern that is read are both put in the compact form that JSON.stringify
// writes. A pattern that is not JSON is left for AWS to reject.
function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

export type EventBridgeRuleInstance = InstanceType<typeof EventBridgeRule>;
