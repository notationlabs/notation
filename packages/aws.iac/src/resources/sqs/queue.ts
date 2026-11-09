import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import * as sdk from "@aws-sdk/client-sqs";
import { sqsClient } from "src/utils/aws-clients";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";
import { awsCreate } from "src/utils/errors";
import { AwsSchema } from "src/utils/types";

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
   * `maxReceiveCount` times without being deleted.
   */
  RedrivePolicy?: RedrivePolicy;
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

type QueueParams = QueueAttributeParams & {
  QueueName: string;
  FifoQueue?: boolean;
};

// SQS returns the FIFO attributes only for a FIFO queue, and the redrive
// policy only for a queue that has one.
type OptionalReadAttributes =
  | "RedrivePolicy"
  | "ContentBasedDeduplication"
  | "DeduplicationScope"
  | "FifoThroughputLimit";

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
// dead-letter queue.
const ATTRIBUTE_DEFAULTS: Required<AttributeValues> = {
  VisibilityTimeout: 30,
  MessageRetentionPeriod: 345_600,
  DelaySeconds: 0,
  ReceiveMessageWaitTimeSeconds: 0,
  MaximumMessageSize: 1_048_576,
  RedrivePolicy: "",
  ContentBasedDeduplication: false,
  DeduplicationScope: "queue",
  FifoThroughputLimit: "perQueue",
};

const ATTRIBUTE_NAMES = Object.keys(
  ATTRIBUTE_DEFAULTS,
) as (keyof QueueAttributeParams)[];

const queue = resource<QueueSchema>({
  type: "aws/sqs/Queue",
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
    value: v.object({
      deadLetterTargetArn: v.string(),
      maxReceiveCount: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(1_000),
      ),
    }),
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
  // CreateQueue returns an existing queue of the same name, so a queue that
  // exists already is reported, instead of being taken over. The create
  // attempt is recorded as a tag, so `find` can tell this deploy's queue
  // from another with the same name.
  create: awsCreate(async (params, _context, token) => {
    if (await getQueueUrl(params.QueueName)) {
      throw new Error(`An SQS queue named ${params.QueueName} already exists`);
    }
    const { QueueName, FifoQueue, ...attributes } = params;
    const command = new sdk.CreateQueueCommand({
      QueueName,
      Attributes: {
        ...toAttributes(attributes),
        ...(FifoQueue ? { FifoQueue: "true" } : {}),
      },
      tags: token
        ? { [CREATE_TOKEN_TAG]: createTokenTagValue(token) }
        : undefined,
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
  }),

  find: async (params, token) => {
    const QueueUrl = await getQueueUrl(params.QueueName);
    if (QueueUrl) {
      const { Tags } = await sqsClient().send(
        new sdk.ListQueueTagsCommand({ QueueUrl }),
      );
      if (Tags?.[CREATE_TOKEN_TAG] === createTokenTagValue(token)) {
        return { QueueUrl };
      }
    }
    throw new ResourceNotFoundError(
      "No SQS queue has the name and the create token",
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
        RedrivePolicy: parseRedrivePolicy(Attributes.RedrivePolicy),
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
    const attributes: AttributeValues = {};
    for (const name of ATTRIBUTE_NAMES) {
      if (name in patch)
        (attributes as Record<string, unknown>)[name] =
          patch[name] ?? ATTRIBUTE_DEFAULTS[name];
    }
    if (Object.keys(attributes).length === 0) return;
    await sqsClient().send(
      new sdk.SetQueueAttributesCommand({
        QueueUrl: key.QueueUrl,
        Attributes: toAttributes(attributes),
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

type AttributeValues = {
  [K in keyof QueueAttributeParams]?: QueueAttributeParams[K] | "";
};

function toAttributes(attributes: AttributeValues) {
  const encoded: Record<string, string> = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (value === undefined) continue;
    encoded[name] =
      typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return encoded;
}

// SQS returns the policy as a JSON string. The count is read with Number(),
// as the string can hold it as a string.
function parseRedrivePolicy(
  policy: string | undefined,
): RedrivePolicy | undefined {
  if (!policy) return undefined;
  const { deadLetterTargetArn, maxReceiveCount } = JSON.parse(policy);
  return { deadLetterTargetArn, maxReceiveCount: Number(maxReceiveCount) };
}
