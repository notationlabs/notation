import type { StandardSchemaV1 } from "@notation/resource";
import type { SqsEvent, SqsOptions, SqsSource } from "./declaration";
import type { LambdaGroup } from "./lambda";
import { resolveLambda, whenLoaded } from "./lambda-declaration";

export type EventSourceMappingConfig<
  S extends StandardSchemaV1 = StandardSchemaV1,
> = SqsOptions & {
  /** The queue that Lambda reads, from `queue()`. */
  source: SqsSource<S>;
  /**
   * The function that Lambda invokes with the queue's messages: a declaration
   * from `$lambda`, passed as `() => lambda`, or a group from `lambda()`. A
   * declaration must be declared with `event: () => sqs.schema(schema)`, or
   * with no event. `sqs.schema()` must be given the queue's schema.
   */
  target: SqsTarget<NoInfer<S>>;
};

/** A Lambda that can read a queue whose schema has the type `S`. */
export type SqsTarget<S extends StandardSchemaV1> =
  | (() => {
      readonly "~lambda"?:
        | { kind: "none" }
        | {
            kind: "sqs";
            event: SqsEvent<S>;
          };
    })
  | LambdaGroup;

/**
 * Maps a queue to a Lambda, so that Lambda invokes the function with the
 * queue's messages. Gives the function's role permission to read the queue.
 * The mapping is made when infra has finished loading. A declaration can map
 * a queue itself, with `event: () => sqs.bind(queue)`.
 * @resource
 */
export function eventSourceMapping<S extends StandardSchemaV1>(
  config: EventSourceMappingConfig<S>,
): void {
  const { source, target, ...options } = config;
  whenLoaded(() => {
    const queueName = queueNameOf(source);
    const { group, event } = resolveLambda(
      target,
      {
        caller: "eventSourceMapping()",
        action: (lambda) => `maps ${queueName} to ${lambda}`,
      },
      "sqs",
    );
    if (event?.kind === "sqs" && source.schema !== event.schema) {
      throw new Error(
        `eventSourceMapping() maps ${queueName} to the Lambda "${group.id}", but the Lambda's event: () => sqs.schema(schema) has another schema than the queue. Give queue() and sqs.schema() the same schema, imported from a shared module.`,
      );
    }
    source["~subscribe"](group, options);
  });
}

function queueNameOf(source: SqsSource<any>): string {
  const id = (source as { id?: unknown }).id;
  return typeof id === "string" ? `the queue "${id}"` : "a queue";
}
