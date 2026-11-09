import type { SqsOptions, SqsSource } from "./declaration";
import {
  declaredQueueOf,
  resolveLambda,
  whenLoaded,
  type LambdaTarget,
} from "./lambda-declaration";

export type EventSourceMappingConfig = SqsOptions & {
  /** The queue that Lambda reads, from `queue()`. */
  source: SqsSource<any>;
  /**
   * The function that Lambda invokes with the queue's messages: a declaration
   * from `$lambda`, passed as `() => lambda`, or a group from `lambda()`. A
   * declaration must be declared with `event: () => sqs()`, or with no event.
   */
  target: LambdaTarget<"sqs" | "none">;
};

/**
 * Maps a queue to a Lambda, so that Lambda invokes the function with the
 * queue's messages. Gives the function's role permission to read the queue.
 * The mapping is made when infra has finished loading. A declaration can map
 * a queue itself, with `event: () => sqs(queue)`.
 * @resource
 */
export function eventSourceMapping(config: EventSourceMappingConfig): void {
  const { source, target, ...options } = config;
  whenLoaded(() => {
    const queue = declaredQueueOf(target);
    if (queue) {
      throw new Error(
        `eventSourceMapping() targets a Lambda that maps ${queue === source ? "the same queue" : "a queue"} in its declaration, with event: () => sqs(queue). Map the queue in one place: remove the eventSourceMapping() call, or declare the Lambda with event: () => sqs().`,
      );
    }
    const group = resolveLambda(target, "eventSourceMapping()", [
      "sqs",
      "none",
    ]);
    source["~subscribe"](group, options);
  });
}
