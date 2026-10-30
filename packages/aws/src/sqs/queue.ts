import * as aws from "@notation/aws.iac";
import type { SqsHandler } from "src/shared/lambda.handler";
import type { LambdaGroup } from "src/lambda";
import { awsName } from "src/naming";

export type QueueConfig = {
  /**
   * Names the queue, and keys it in state. The queue is named
   * `<app>-<stage>-<name>` in AWS. Changing the name replaces the queue.
   * A FIFO queue's name ends in `.fifo`.
   */
  name: string;
  fifo?: boolean;
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

export type ConsumeOptions = {
  /** The most messages the function receives in one invocation. */
  batchSize?: number;
  /** Seconds to wait to fill a batch before the function is invoked. */
  maxBatchingWindow?: number;
};

export class QueueGroup extends aws.AwsResourceGroup<QueueConfig> {
  readonly queue: aws.sqs.QueueInstance;
  /** The queue's ARN. It is an output value, filled in at deploy. */
  readonly arn: string;
  /** The queue's URL. It is an output value, filled in at deploy. */
  readonly url: string;

  constructor(config: QueueConfig) {
    super("aws/sqs/queue", config.name, config);
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
   * Invokes the function with the queue's messages. Gives the function's
   * role permission to read the queue, and maps the queue to the function.
   */
  consume(
    handler: SqsHandler | LambdaGroup,
    options: ConsumeOptions = {},
  ): aws.lambda.LambdaEventSourceMappingInstance {
    // at compile time, a runtime handler import becomes a lambda group
    const lambdaGroup = handler as LambdaGroup;
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
    return this.add(
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

export const queue = (config: QueueConfig) => new QueueGroup(config);
