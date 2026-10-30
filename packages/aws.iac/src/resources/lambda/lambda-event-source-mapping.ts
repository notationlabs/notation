import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";
import { awsCreate } from "src/utils/errors";
import { runLambdaMutation } from "src/utils/lambda-mutation";
import { AwsSchema } from "src/utils/types";
import type { LambdaRolePolicyInstance } from "./lambda-role-policy";

type EventSourceMappingParams = {
  EventSourceArn: string;
  FunctionName: string;
  BatchSize?: number;
  MaximumBatchingWindowInSeconds?: number;
  Enabled?: boolean;
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
  > & { Enabled: boolean };
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
});

const lambdaEventSourceMappingSchema = lambdaEventSourceMapping.defineSchema({
  UUID: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  EventSourceArn: {
    propertyType: "param",
    presence: "required",
    immutable: true,
  },
  EventSourceMappingArn: {
    propertyType: "computed",
    presence: "required",
  },
  FunctionName: {
    propertyType: "param",
    presence: "required",
  },
  FunctionArn: {
    propertyType: "computed",
    presence: "required",
  },
  BatchSize: {
    propertyType: "param",
    presence: "optional",
  },
  MaximumBatchingWindowInSeconds: {
    propertyType: "param",
    presence: "optional",
  },
  Enabled: {
    propertyType: "param",
    presence: "optional",
  },
  State: {
    propertyType: "computed",
    presence: "required",
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
    // AWS assigns the UUID, so the create attempt is recorded as a tag for
    // `find` to search for.
    create: awsCreate(async (params, _context, token) => {
      const command = new sdk.CreateEventSourceMappingCommand({
        ...params,
        Tags: token
          ? { [CREATE_TOKEN_TAG]: createTokenTagValue(token) }
          : undefined,
      });
      const result = await runMappingMutation(() => lambdaClient.send(command));
      return { UUID: result.UUID! };
    }),

    find: async (params, token) => {
      const value = createTokenTagValue(token);
      let Marker: string | undefined;
      do {
        const page = await lambdaClient.send(
          new sdk.ListEventSourceMappingsCommand({
            EventSourceArn: params.EventSourceArn,
            FunctionName: params.FunctionName,
            Marker,
          }),
        );
        for (const mapping of page.EventSourceMappings ?? []) {
          const { Tags } = await lambdaClient.send(
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
        const result = await lambdaClient.send(
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
    // removed from config is reset to the API's default.
    update: async (key, patch, params) => {
      const defaults: Omit<EventSourceMappingParams, "EventSourceArn"> = {
        FunctionName: params.FunctionName,
        BatchSize: defaultBatchSize(params.EventSourceArn),
        MaximumBatchingWindowInSeconds: 0,
        Enabled: true,
      };
      const changes = Object.fromEntries(
        (Object.keys(patch) as (keyof typeof defaults)[]).map((name) => [
          name,
          patch[name] ?? defaults[name],
        ]),
      );
      await runMappingMutation(() =>
        lambdaClient.send(
          new sdk.UpdateEventSourceMappingCommand({ ...key, ...changes }),
        ),
      );
    },

    delete: async (key) => {
      try {
        await runMappingMutation(() =>
          lambdaClient.send(new sdk.DeleteEventSourceMappingCommand(key)),
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
