import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/resources/utils/aws-clients";
import {
  CREATE_TOKEN_TAG,
  createTokenTagValue,
} from "src/resources/utils/create-token";
import { awsCreate } from "src/resources/utils/errors";
import { runLambdaMutation } from "src/resources/utils/lambda-mutation";
import { AwsSchema } from "src/resources/utils/types";
import type { LambdaRolePolicyInstance } from "./lambda-role-policy";

type EventSourceMappingParams = {
  EventSourceArn: string;
  FunctionName: string;
  BatchSize?: number;
  MaximumBatchingWindowInSeconds?: number;
  Enabled?: boolean;
  /**
   * `["ReportBatchItemFailures"]` lets the function return the messages that
   * failed, as `{ batchItemFailures }`, so Lambda retries only those.
   */
  FunctionResponseTypes?: "ReportBatchItemFailures"[];
  /** For SQS: the most instances of the function that the mapping invokes at once. */
  ScalingConfig?: { MaximumConcurrency?: number };
};

export type LambdaEventSourceMappingSchema = AwsSchema<{
  Key: { UUID: string };
  CreateParams: EventSourceMappingParams;
  UpdateParams: Omit<EventSourceMappingParams, "EventSourceArn">;
  ReadResult: Required<
    Pick<
      sdk.EventSourceMappingConfiguration,
      | "UUID"
      | "EventSourceArn"
      | "EventSourceMappingArn"
      | "FunctionArn"
      | "BatchSize"
      | "MaximumBatchingWindowInSeconds"
      | "State"
    >
  > &
    Pick<
      EventSourceMappingParams,
      "FunctionResponseTypes" | "ScalingConfig"
    > & {
      Enabled: boolean;
    };
}>;

export type LambdaEventSourceMappingDependencies = {
  /**
   * The policy that grants the function access to the event source. AWS
   * checks the role's permissions when the mapping is created, so the
   * mapping waits for the policy, though it reads nothing from it.
   */
  policy?: LambdaRolePolicyInstance;
};

const lambdaEventSourceMapping = resource<LambdaEventSourceMappingSchema>({
  type: "aws/lambda/LambdaEventSourceMapping",
  provider: "@notation/aws/resources",
});

const lambdaEventSourceMappingSchema = lambdaEventSourceMapping.defineSchema({
  UUID: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
    primaryKey: true,
  },
  EventSourceArn: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
    immutable: true,
  },
  EventSourceMappingArn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  FunctionName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  FunctionArn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  BatchSize: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)),
  },
  MaximumBatchingWindowInSeconds: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(300)),
  },
  Enabled: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  FunctionResponseTypes: {
    propertyType: "param",
    presence: "optional",
    value: v.array(v.literal("ReportBatchItemFailures")),
  },
  ScalingConfig: {
    propertyType: "param",
    presence: "optional",
    value: v.object({
      MaximumConcurrency: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(1_000)),
      ),
    }),
  },
  State: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
    volatile: true,
  },
} as const);

const TRANSITIONAL_STATES = new Set([
  "Creating",
  "Enabling",
  "Disabling",
  "Updating",
  "Deleting",
]);

export const LambdaEventSourceMapping = lambdaEventSourceMappingSchema
  .defineOperations({
    ownership: "token",
    // AWS assigns the UUID, so create tags the mapping with the create
    // token, and `find` searches for that tag.
    create: awsCreate(async (params, _context, token) => {
      const command = new sdk.CreateEventSourceMappingCommand({
        ...params,
        Tags: { [CREATE_TOKEN_TAG]: createTokenTagValue(token) },
      });
      const result = await runMappingMutation(() =>
        lambdaClient().send(command),
      );
      return { UUID: result.UUID! };
    }),

    find: async (params, token) => {
      const value = createTokenTagValue(token);
      let Marker: string | undefined;
      do {
        const page = await lambdaClient().send(
          new sdk.ListEventSourceMappingsCommand({
            EventSourceArn: params.EventSourceArn,
            FunctionName: params.FunctionName,
            Marker,
          }),
        );
        for (const mapping of page.EventSourceMappings ?? []) {
          const { Tags } = await lambdaClient().send(
            new sdk.ListTagsCommand({
              Resource: mapping.EventSourceMappingArn,
            }),
          );
          if (Tags?.[CREATE_TOKEN_TAG] === value)
            return { UUID: mapping.UUID! };
        }
        Marker = page.NextMarker;
      } while (Marker);
      throw new ResourceNotFoundError(
        "No event source mapping has the create token",
      );
    },

    read: async (key) => {
      try {
        const result = await lambdaClient().send(
          new sdk.GetEventSourceMappingCommand(key),
        );
        if (TRANSITIONAL_STATES.has(result.State!)) {
          throw new ResourceOperationPendingError(
            `Waiting for event source mapping to leave the ${result.State} state`,
            { retryAfterMs: 1_000 },
          );
        }
        return {
          UUID: result.UUID!,
          EventSourceArn: result.EventSourceArn!,
          EventSourceMappingArn: result.EventSourceMappingArn!,
          FunctionArn: result.FunctionArn!,
          BatchSize: result.BatchSize!,
          MaximumBatchingWindowInSeconds:
            result.MaximumBatchingWindowInSeconds!,
          State: result.State!,
          Enabled: result.State === "Enabled",
          FunctionResponseTypes: (result.FunctionResponseTypes ??
            []) as "ReportBatchItemFailures"[],
          ScalingConfig: result.ScalingConfig ?? {},
        };
      } catch (error) {
        if (error instanceof sdk.ResourceNotFoundException) {
          throw new ResourceNotFoundError(
            "Event source mapping was not found",
            { cause: error },
          );
        }
        throw error;
      }
    },

    // UpdateEventSourceMapping leaves an omitted field as it was, so a field
    // removed from config is reset to the API's default. An empty
    // FunctionResponseTypes or ScalingConfig removes the setting.
    update: async (key, patch, params) => {
      const defaults: Omit<EventSourceMappingParams, "EventSourceArn"> = {
        FunctionName: params.FunctionName,
        BatchSize: defaultBatchSize(params.EventSourceArn),
        MaximumBatchingWindowInSeconds: 0,
        Enabled: true,
        FunctionResponseTypes: [],
        ScalingConfig: {},
      };
      const changes = Object.fromEntries(
        (Object.keys(patch) as (keyof typeof defaults)[]).map((name) => [
          name,
          patch[name] ?? defaults[name],
        ]),
      );
      await runMappingMutation(() =>
        lambdaClient().send(
          new sdk.UpdateEventSourceMappingCommand({ ...key, ...changes }),
        ),
      );
    },

    delete: async (key) => {
      try {
        await runMappingMutation(() =>
          lambdaClient().send(new sdk.DeleteEventSourceMappingCommand(key)),
        );
      } catch (error) {
        if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
      }
    },
  })
  .requireDependencies<LambdaEventSourceMappingDependencies>()
  .deriveParams(() => ({}));

export type LambdaEventSourceMappingInstance = InstanceType<
  typeof LambdaEventSourceMapping
>;

// SQS and Amazon MQ sources default to 10 records a batch; streams to 100.
function defaultBatchSize(eventSourceArn: string): number {
  return /^arn:[^:]+:(sqs|mq):/.test(eventSourceArn) ? 10 : 100;
}

// A mapping in a transitional state rejects changes until the state settles.
async function runMappingMutation<T>(mutation: () => Promise<T>): Promise<T> {
  try {
    return await runLambdaMutation(mutation);
  } catch (error) {
    if (error instanceof sdk.ResourceInUseException) {
      throw new ResourceOperationPendingError(
        "Waiting for event source mapping to finish changing",
        { retryAfterMs: 1_000, cause: error },
      );
    }
    throw error;
  }
}
