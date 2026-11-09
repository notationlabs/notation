import * as aws from "@notation/aws.iac";
import type { LambdaGroup } from "src/lambda/lambda";
import type { SqsOptions } from "src/lambda/declaration";
import type { StandardSchemaV1 } from "@notation/resource";
import { awsName } from "src/naming";

export type QueueConfig<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  /**
   * Names the queue, and keys it in state. The queue is named
   * `<app>--<stage>--<name>` in AWS. Changing the name replaces the queue.
   * A FIFO queue's name ends in `.fifo`.
   */
  name: string;
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
    super("aws/sqs/queue", config.name, config);
    this.schema = schema as S;
    this.queue = this.add(
      new aws.sqs.Queue(`${config.name}-queue`, {
        config: {
          QueueName: awsName("sqsQueue", config.name),
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
 * Declares an SQS queue.
 * @resource runtime: schema
 */
export function queue<S extends StandardSchemaV1 | undefined = undefined>(
  config: QueueConfig<S>,
): QueueGroup<S> {
  return new QueueGroup(config);
}
