import * as aws from "@notation/aws.iac";
import type { LambdaGroup } from "src/lambda/lambda";
import type { SqsOptions } from "src/lambda/declaration";
import type { StandardSchemaV1 } from "@notation/resource";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import { assertId, assertName, resourceId, type IdOption } from "src/id";

export type QueueConfig<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /**
   * Keys the queue in state. Changing the id replaces the queue, so keep it
   * stable. Must be name-safe: 1 to 64 letters, digits, hyphens or
   * underscores.
   */
  id: string;
  /**
   * The queue's name in AWS, in place of the id. The queue is named
   * `<app>--<stage>--<name>`. Changing the name replaces the queue. Must be
   * name-safe.
   */
  name?: string;
  /**
   * Makes a FIFO queue. Its AWS name ends in `.fifo`, which Notation adds.
   * It can't change after the queue is created.
   */
  fifo?: boolean;
  /**
   * Validates the JSON body of each message, in `decode()` of a Lambda
   * declared with `sqs.bind(queue)`, or with `sqs.schema(schema)` and mapped
   * with `eventSourceMapping()`. `sqs.schema()` must be given this schema.
   * Import it from a shared module, so the function can load it. A queue
   * that takes any JSON body declares a schema such as `v.unknown()`.
   */
  schema: S;
  /** Seconds a received message stays hidden from other consumers. */
  visibilityTimeout?: number;
  /** Seconds the queue keeps a message. */
  messageRetentionPeriod?: number;
  /** Seconds each message is delayed before it can be received. */
  delaySeconds?: number;
  /** Seconds a receive call waits for a message to arrive. */
  receiveMessageWaitTime?: number;
  /** The most bytes a message can hold, from 1,024 to 1,048,576. */
  maximumMessageSize?: number;
  /**
   * The queue that SQS moves a message to after the message has been
   * received `maxReceiveCount` times without being deleted. The dead-letter
   * queue must be FIFO if this queue is, and standard if this queue is.
   */
  deadLetterQueue?: DeadLetterQueueConfig;
  /**
   * FIFO only. Deduplicates messages by a SHA-256 hash of the body, so a
   * sender doesn't have to give a deduplication ID.
   */
  contentBasedDeduplication?: boolean;
  /**
   * FIFO only. Whether SQS deduplicates messages across the queue, or within
   * each message group. Set it to `"messageGroup"`, with `fifoThroughputLimit:
   * "perMessageGroupId"`, for high throughput.
   */
  deduplicationScope?: "queue" | "messageGroup";
  /**
   * FIFO only. Whether the throughput quota applies to the whole queue, or
   * to each message group. `"perMessageGroupId"` needs `deduplicationScope:
   * "messageGroup"`.
   */
  fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
};

export type DeadLetterQueueConfig = {
  /** The dead-letter queue, from `queue()`. */
  queue: QueueGroup<any>;
  /** The number of receives after which SQS moves a message, from 1 to 1,000. */
  maxReceiveCount: number;
};

export type SqsAction =
  | "SendMessage"
  | "ReceiveMessage"
  | "DeleteMessage"
  | "ChangeMessageVisibility"
  | "GetQueueAttributes"
  | "GetQueueUrl"
  | "PurgeQueue";

export class QueueGroup<
  S extends StandardSchemaV1 = StandardSchemaV1,
> extends aws.AwsResourceGroup<Omit<QueueConfig, "schema">> {
  readonly queue: aws.sqs.QueueInstance;
  readonly schema: S;
  /** The queue's ARN. It is an output value, filled in at deploy. */
  readonly arn: string;
  /** The queue's URL. It is an output value, filled in at deploy. */
  readonly url: string;

  constructor({ schema, ...config }: QueueConfig<S>) {
    assertId("queue()", config.id);
    assertName("queue()", config.name);
    assertFifoOptions(config);
    const name = config.name ?? config.id;
    const queueName = awsName("sqsQueue", config.fifo ? `${name}.fifo` : name);
    super("aws/sqs/queue", config.id, config);
    claimAwsName(
      "SQS queues",
      queueName,
      describeDeclaration("queue()", config.id, config.name),
    );
    this.schema = schema;
    this.queue = this.add(
      new aws.sqs.Queue(resourceId("sqs-queue", config.id), {
        config: {
          QueueName: queueName,
          FifoQueue: config.fifo,
          VisibilityTimeout: config.visibilityTimeout,
          MessageRetentionPeriod: config.messageRetentionPeriod,
          DelaySeconds: config.delaySeconds,
          ReceiveMessageWaitTimeSeconds: config.receiveMessageWaitTime,
          MaximumMessageSize: config.maximumMessageSize,
          RedrivePolicy: config.deadLetterQueue && {
            deadLetterTargetArn: config.deadLetterQueue.queue.arn,
            maxReceiveCount: config.deadLetterQueue.maxReceiveCount,
          },
          ContentBasedDeduplication: config.contentBasedDeduplication,
          DeduplicationScope: config.deduplicationScope,
          FifoThroughputLimit: config.fifoThroughputLimit,
        },
      }),
    );
    this.arn = this.queue.outputValue("QueueArn");
    this.url = this.queue.outputValue("QueueUrl");
  }

  /** A policy statement that allows the actions on this queue. */
  grant(actions: SqsAction[]): aws.lambda.PolicyStatement {
    return {
      Effect: "Allow",
      Action: actions.map((action) => `sqs:${action}`),
      Resource: this.arn,
    };
  }

  /**
   * Maps the queue to a Lambda, for `sqs.bind(queue)` in a declaration and for
   * `eventSourceMapping()`.
   */
  "~subscribe"(lambdaGroup: LambdaGroup, options: SqsOptions = {}): void {
    const id = resourceId("sqs-mapping", this.id, lambdaGroup.id);
    if (this.resources.some((resource) => resource.id === id)) {
      throw new Error(`Queue ${this.id} already feeds ${lambdaGroup.id}`);
    }

    lambdaGroup.policy.contribute({
      PolicyDocument: {
        Statement: [
          this.grant(["ReceiveMessage", "DeleteMessage", "GetQueueAttributes"]),
        ],
      },
    });
    this.add(
      new aws.lambda.LambdaEventSourceMapping(id, {
        config: {
          EventSourceArn: this.arn,
          FunctionName: lambdaGroup.fn.outputValue("FunctionName"),
          BatchSize: options.batchSize,
          MaximumBatchingWindowInSeconds: options.maxBatchingWindow,
          FunctionResponseTypes: options.reportBatchItemFailures
            ? ["ReportBatchItemFailures"]
            : undefined,
          ScalingConfig:
            options.maximumConcurrency === undefined
              ? undefined
              : { MaximumConcurrency: options.maximumConcurrency },
          Enabled: options.enabled,
        },
        dependencies: { policy: lambdaGroup.policy },
      }),
    );
  }
}

// SQS rejects the FIFO attributes on a standard queue, and a dead-letter
// queue of the other type, but only at deploy.
function assertFifoOptions(config: Omit<QueueConfig, "schema">): void {
  const fifo = config.fifo ?? false;
  if (!fifo) {
    const set = (
      [
        "contentBasedDeduplication",
        "deduplicationScope",
        "fifoThroughputLimit",
      ] as const
    ).filter((option) => config[option] !== undefined);
    if (set.length > 0) {
      throw new Error(
        `queue() "${config.id}" sets ${set.join(", ")}, which only a FIFO queue has. Set fifo: true, or remove ${set.length > 1 ? "them" : "it"}.`,
      );
    }
  }
  const dlq = config.deadLetterQueue?.queue;
  if (dlq && (dlq.config.fifo ?? false) !== fifo) {
    throw new Error(
      `queue() "${config.id}" is a ${fifo ? "FIFO" : "standard"} queue, but its dead-letter queue "${dlq.id}" is ${fifo ? "a standard" : "a FIFO"} queue. SQS needs both queues to be of the same type.`,
    );
  }
}

/**
 * Declares an SQS queue. `id` must be a name-safe string literal; see
 * `NameSafe`.
 * @resource runtime: schema
 */
export function queue<
  S extends StandardSchemaV1,
  const Id extends string = never,
>(config: Omit<QueueConfig<S>, "id"> & { id: IdOption<Id> }): QueueGroup<S> {
  return new QueueGroup(config);
}
