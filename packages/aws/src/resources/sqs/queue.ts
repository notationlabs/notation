import * as v from "valibot";
import {
  resource,
  ResourceAlreadyExistsError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-sqs";
import { sqsClient } from "src/resources/utils/aws-clients";
import { awsCreate } from "src/resources/utils/errors";
import { AwsSchema } from "src/resources/utils/types";

/** The queue attributes that can be changed after the queue is created. */
type QueueAttributeParams = {
  /** Seconds a received message stays hidden from other consumers. */
  VisibilityTimeout?: number;
  /** Seconds the queue keeps a message. */
  MessageRetentionPeriod?: number;
  /** Seconds each message is delayed before it can be received. */
  DelaySeconds?: number;
  /** Seconds a receive call waits for a message to arrive. */
  ReceiveMessageWaitTimeSeconds?: number;
  /** The most bytes a message can hold. */
  MaximumMessageSize?: number;
  /**
   * The queue that SQS moves a message to after it has been received
   * `maxReceiveCount` times without being deleted. `""` means no dead-letter
   * queue, as in the SQS API.
   */
  RedrivePolicy?: RedrivePolicy | "";
  /**
   * The source queues that can use this queue as their dead-letter queue.
   * Without it, any queue in the account and region can. `""` means no
   * policy, as in the SQS API.
   */
  RedriveAllowPolicy?: RedriveAllowPolicy | "";
  /** FIFO only. Deduplicates messages by a hash of their body. */
  ContentBasedDeduplication?: boolean;
  /** FIFO only. Whether deduplication applies to the queue or to each message group. */
  DeduplicationScope?: "queue" | "messageGroup";
  /** FIFO only. Whether the throughput quota applies to the queue or to each message group. */
  FifoThroughputLimit?: "perQueue" | "perMessageGroupId";
};

export type RedrivePolicy = {
  deadLetterTargetArn: string;
  maxReceiveCount: number;
};

export type RedriveAllowPolicy =
  | { redrivePermission: "allowAll" | "denyAll" }
  | {
      redrivePermission: "byQueue";
      /** The ARNs of the source queues, from 1 to 10. */
      sourceQueueArns: string[];
    };

type QueueParams = QueueAttributeParams & {
  QueueName: string;
  FifoQueue?: boolean;
};

// SQS returns the FIFO attributes only for a FIFO queue.
type OptionalReadAttributes =
  "ContentBasedDeduplication" | "DeduplicationScope" | "FifoThroughputLimit";

export type QueueSchema = AwsSchema<{
  Key: { QueueUrl: string };
  CreateParams: QueueParams;
  UpdateParams: QueueAttributeParams;
  ReadResult: Required<Omit<QueueParams, OptionalReadAttributes>> &
    Pick<QueueParams, OptionalReadAttributes> & {
      QueueUrl: string;
      QueueArn: string;
    };
}>;

// SetQueueAttributes cannot unset an attribute, so a removed attribute is
// set to the value SQS gives a new queue. An empty RedrivePolicy removes the
// dead-letter queue, and an empty RedriveAllowPolicy removes the allow policy.
const ATTRIBUTE_DEFAULTS: Record<keyof QueueAttributeParams, string> = {
  VisibilityTimeout: "30",
  MessageRetentionPeriod: "345600",
  DelaySeconds: "0",
  ReceiveMessageWaitTimeSeconds: "0",
  MaximumMessageSize: "1048576",
  RedrivePolicy: "",
  RedriveAllowPolicy: "",
  ContentBasedDeduplication: "false",
  DeduplicationScope: "queue",
  FifoThroughputLimit: "perQueue",
};

const ATTRIBUTE_NAMES = Object.keys(
  ATTRIBUTE_DEFAULTS,
) as (keyof QueueAttributeParams)[];

const queue = resource<QueueSchema>({
  type: "aws/sqs/Queue",
  provider: "@notation/aws/resources",
});

const seconds = (max: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));

const queueSchema = queue.defineSchema({
  QueueUrl: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  QueueArn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  QueueName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.string(),
  },
  FifoQueue: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.boolean(),
  },
  VisibilityTimeout: {
    propertyType: "param",
    presence: "optional",
    value: seconds(43_200),
  },
  MessageRetentionPeriod: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(60),
      v.maxValue(1_209_600),
    ),
  },
  DelaySeconds: {
    propertyType: "param",
    presence: "optional",
    value: seconds(900),
  },
  ReceiveMessageWaitTimeSeconds: {
    propertyType: "param",
    presence: "optional",
    value: seconds(20),
  },
  MaximumMessageSize: {
    propertyType: "param",
    presence: "optional",
    value: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1_024),
      v.maxValue(1_048_576),
    ),
  },
  RedrivePolicy: {
    propertyType: "param",
    presence: "optional",
    value: v.union([
      v.literal(""),
      v.object({
        deadLetterTargetArn: v.string(),
        maxReceiveCount: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(1_000),
        ),
      }),
    ]),
  },
  RedriveAllowPolicy: {
    propertyType: "param",
    presence: "optional",
    value: v.union([
      v.literal(""),
      v.variant("redrivePermission", [
        v.object({ redrivePermission: v.picklist(["allowAll", "denyAll"]) }),
        v.object({
          redrivePermission: v.literal("byQueue"),
          sourceQueueArns: v.pipe(
            v.array(v.string()),
            v.minLength(1),
            v.maxLength(10),
          ),
        }),
      ]),
    ]),
  },
  ContentBasedDeduplication: {
    propertyType: "param",
    presence: "optional",
    value: v.boolean(),
  },
  DeduplicationScope: {
    propertyType: "param",
    presence: "optional",
    value: v.picklist(["queue", "messageGroup"]),
  },
  FifoThroughputLimit: {
    propertyType: "param",
    presence: "optional",
    value: v.picklist(["perQueue", "perMessageGroupId"]),
  },
} as const);

export const Queue = queueSchema.defineOperations({
  ownership: "parent",
  // CreateQueue returns an existing queue of the same name instead of
  // failing, so create checks for the queue first.
  create: awsCreate(
    async (params) => {
      if (await getQueueUrl(params.QueueName)) {
        throw new ResourceAlreadyExistsError(
          `An SQS queue named ${params.QueueName} already exists`,
        );
      }
      const { QueueName, FifoQueue, ...attributes } = params;
      const command = new sdk.CreateQueueCommand({
        QueueName,
        Attributes: {
          ...toAttributes(attributes),
          ...(FifoQueue ? { FifoQueue: "true" } : {}),
        },
      });
      try {
        const result = await sqsClient().send(command);
        return { QueueUrl: result.QueueUrl! };
      } catch (error) {
        if (error instanceof sdk.QueueDeletedRecently) {
          throw new ResourceOperationPendingError(
            "Waiting to reuse the name of a recently deleted queue",
            { retryAfterMs: 5_000, cause: error },
          );
        }
        throw error;
      }
    },
    { alreadyExists: (error) => error instanceof sdk.QueueNameExists },
  ),

  // The queue's key is its URL, which a takeover has to look up by name.
  find: async (params) => {
    const QueueUrl = await getQueueUrl(params.QueueName);
    if (QueueUrl) return { QueueUrl };
    throw new ResourceNotFoundError(
      `No SQS queue is named ${params.QueueName}`,
    );
  },

  read: async (key) => {
    try {
      const { Attributes = {} } = await sqsClient().send(
        new sdk.GetQueueAttributesCommand({
          QueueUrl: key.QueueUrl,
          AttributeNames: ["All"],
        }),
      );
      return {
        QueueUrl: key.QueueUrl,
        QueueArn: Attributes.QueueArn!,
        QueueName: key.QueueUrl.split("/").pop()!,
        FifoQueue: Attributes.FifoQueue === "true",
        VisibilityTimeout: Number(Attributes.VisibilityTimeout),
        MessageRetentionPeriod: Number(Attributes.MessageRetentionPeriod),
        DelaySeconds: Number(Attributes.DelaySeconds),
        ReceiveMessageWaitTimeSeconds: Number(
          Attributes.ReceiveMessageWaitTimeSeconds,
        ),
        MaximumMessageSize: Number(Attributes.MaximumMessageSize),
        // SQS returns a redrive policy only when the queue has one. A missing
        // policy is read as "", and not undefined, so that drift detection
        // finds a policy that was removed outside Notation.
        RedrivePolicy: parseRedrivePolicy(Attributes.RedrivePolicy),
        RedriveAllowPolicy: Attributes.RedriveAllowPolicy
          ? JSON.parse(Attributes.RedriveAllowPolicy)
          : "",
        ContentBasedDeduplication:
          Attributes.ContentBasedDeduplication === undefined
            ? undefined
            : Attributes.ContentBasedDeduplication === "true",
        DeduplicationScope: Attributes.DeduplicationScope as
          QueueAttributeParams["DeduplicationScope"] | undefined,
        FifoThroughputLimit: Attributes.FifoThroughputLimit as
          QueueAttributeParams["FifoThroughputLimit"] | undefined,
      };
    } catch (error) {
      if (error instanceof sdk.QueueDoesNotExist) {
        throw new ResourceNotFoundError("SQS queue was not found", {
          cause: error,
        });
      }
      throw error;
    }
  },

  update: async (key, patch) => {
    const attributes: Record<string, string> = {};
    for (const name of ATTRIBUTE_NAMES) {
      if (!(name in patch)) continue;
      const value = patch[name];
      attributes[name] =
        value === undefined ? ATTRIBUTE_DEFAULTS[name] : encode(value);
    }
    if (Object.keys(attributes).length === 0) return;
    await sqsClient().send(
      new sdk.SetQueueAttributesCommand({
        QueueUrl: key.QueueUrl,
        Attributes: attributes,
      }),
    );
  },

  delete: async (key) => {
    try {
      await sqsClient().send(new sdk.DeleteQueueCommand(key));
    } catch (error) {
      if (!(error instanceof sdk.QueueDoesNotExist)) throw error;
    }
  },
});

export type QueueInstance = InstanceType<typeof Queue>;

async function getQueueUrl(QueueName: string): Promise<string | undefined> {
  try {
    const { QueueUrl } = await sqsClient().send(
      new sdk.GetQueueUrlCommand({ QueueName }),
    );
    return QueueUrl;
  } catch (error) {
    if (error instanceof sdk.QueueDoesNotExist) return undefined;
    throw error;
  }
}

// An empty policy is left out, as a new queue has no policy, and SQS might
// not accept "" in CreateQueue.
function toAttributes(attributes: QueueAttributeParams) {
  const encoded: Record<string, string> = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (value !== undefined && value !== "") encoded[name] = encode(value);
  }
  return encoded;
}

// SQS takes every attribute as a string, and a policy as JSON.
const encode = (value: string | number | boolean | object) =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

// SQS returns the policy as a JSON string, in which maxReceiveCount can be a
// number or a string, so the count is converted with Number().
function parseRedrivePolicy(policy: string | undefined): RedrivePolicy | "" {
  if (!policy) return "";
  const { deadLetterTargetArn, maxReceiveCount } = JSON.parse(policy);
  return { deadLetterTargetArn, maxReceiveCount: Number(maxReceiveCount) };
}
