import * as aws from "@notation/aws.iac";
import type { LambdaGroup } from "src/lambda/lambda";
import type { SqsOptions } from "src/lambda/declaration";
import type { StandardSchemaV1 } from "@notation/resource";
import { awsName } from "src/naming";
import { assertId, assertName, type NameSafe } from "src/id";

export type QueueConfig<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
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
   * Import it from a shared module, so the function can load it.
   */
  schema?: S;
  /** Seconds a received message stays hidden from other consumers. */
  visibilityTimeout?: number;
  /** Seconds the queue keeps a message. */
  messageRetentionPeriod?: number;
  /** Seconds each message is delayed before it can be received. */
  delaySeconds?: number;
  /** Seconds a receive call waits for a message to arrive. */
  receiveMessageWaitTime?: number;
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
  S extends StandardSchemaV1 | undefined = undefined,
> extends aws.AwsResourceGroup<QueueConfig> {
  readonly queue: aws.sqs.QueueInstance;
  readonly schema: S;
  /** The queue's ARN. It is an output value, filled in at deploy. */
  readonly arn: string;
  /** The queue's URL. It is an output value, filled in at deploy. */
  readonly url: string;

  constructor({ schema, ...config }: QueueConfig<S>) {
    assertId("queue()", config.id);
    assertName("queue()", config.name);
    super("aws/sqs/queue", config.id, config);
    this.schema = schema as S;
    const name = config.name ?? config.id;
    this.queue = this.add(
      new aws.sqs.Queue(`${config.id}-queue`, {
        config: {
          QueueName: awsName("sqsQueue", config.fifo ? `${name}.fifo` : name),
          FifoQueue: config.fifo,
          VisibilityTimeout: config.visibilityTimeout,
          MessageRetentionPeriod: config.messageRetentionPeriod,
          DelaySeconds: config.delaySeconds,
          ReceiveMessageWaitTimeSeconds: config.receiveMessageWaitTime,
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
    const id = `${this.id}-${lambdaGroup.fn.id}-mapping`;
    if (this.resources.some((resource) => resource.id === id)) {
      throw new Error(`Queue ${this.id} already feeds ${lambdaGroup.fn.id}`);
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
        },
        dependencies: { policy: lambdaGroup.policy },
      }),
    );
  }
}

/**
 * Declares an SQS queue. `id` must be a name-safe string literal; see
 * `NameSafe`.
 * @resource runtime: schema
 */
export function queue<
  S extends StandardSchemaV1 | undefined = undefined,
  const Id extends string = string,
>(config: Omit<QueueConfig<S>, "id"> & { id: NameSafe<Id> }): QueueGroup<S> {
  return new QueueGroup(config);
}
