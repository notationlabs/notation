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
};

type QueueParams = QueueAttributeParams & {
  QueueName: string;
  FifoQueue?: boolean;
};

export type QueueSchema = AwsSchema<{
  Key: { QueueUrl: string };
  CreateParams: QueueParams;
  UpdateParams: QueueAttributeParams;
  ReadResult: Required<QueueParams> & { QueueUrl: string; QueueArn: string };
}>;

// SetQueueAttributes cannot unset an attribute, so a removed attribute is
// set to the value SQS gives a new queue.
const ATTRIBUTE_DEFAULTS: Required<QueueAttributeParams> = {
  VisibilityTimeout: 30,
  MessageRetentionPeriod: 345_600,
  DelaySeconds: 0,
  ReceiveMessageWaitTimeSeconds: 0,
};

const ATTRIBUTE_NAMES = Object.keys(
  ATTRIBUTE_DEFAULTS,
) as (keyof QueueAttributeParams)[];

const queue = resource<QueueSchema>({
  type: "aws/sqs/Queue",
});

const queueSchema = queue.defineSchema({
  QueueUrl: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
  },
  QueueArn: {
    propertyType: "computed",
    presence: "required",
  },
  QueueName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
  },
  FifoQueue: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
  },
  VisibilityTimeout: {
    propertyType: "param",
    presence: "optional",
  },
  MessageRetentionPeriod: {
    propertyType: "param",
    presence: "optional",
  },
  DelaySeconds: {
    propertyType: "param",
    presence: "optional",
  },
  ReceiveMessageWaitTimeSeconds: {
    propertyType: "param",
    presence: "optional",
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
      const result = await sqsClient.send(command);
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
      const { Tags } = await sqsClient.send(
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
      const { Attributes = {} } = await sqsClient.send(
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
    const attributes: QueueAttributeParams = {};
    for (const name of ATTRIBUTE_NAMES) {
      if (name in patch)
        attributes[name] = patch[name] ?? ATTRIBUTE_DEFAULTS[name];
    }
    if (Object.keys(attributes).length === 0) return;
    await sqsClient.send(
      new sdk.SetQueueAttributesCommand({
        QueueUrl: key.QueueUrl,
        Attributes: toAttributes(attributes),
      }),
    );
  },

  delete: async (key) => {
    try {
      await sqsClient.send(new sdk.DeleteQueueCommand(key));
    } catch (error) {
      if (!(error instanceof sdk.QueueDoesNotExist)) throw error;
    }
  },
});

export type QueueInstance = InstanceType<typeof Queue>;

async function getQueueUrl(QueueName: string): Promise<string | undefined> {
  try {
    const { QueueUrl } = await sqsClient.send(
      new sdk.GetQueueUrlCommand({ QueueName }),
    );
    return QueueUrl;
  } catch (error) {
    if (error instanceof sdk.QueueDoesNotExist) return undefined;
    throw error;
  }
}

function toAttributes(attributes: QueueAttributeParams) {
  const encoded: Record<string, string> = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (value !== undefined) encoded[name] = String(value);
  }
  return encoded;
}
