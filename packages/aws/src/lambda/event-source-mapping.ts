import type { StandardSchemaV1 } from "@notation/resource";
import type { SqsEvent, SqsOptions, SqsSource } from "./declaration";
import type { LambdaGroup } from "./lambda";
import { declarationOf, resolveLambda, whenLoaded } from "./lambda-declaration";

export type EventSourceMappingConfig<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = SqsOptions & {
  /** The queue that Lambda reads, from `queue()`. */
  source: SqsSource<S>;
  /**
   * The function that Lambda invokes with the queue's messages: a declaration
   * from `$lambda`, passed as `() => lambda`, or a group from `lambda()`. A
   * declaration must be declared with `event: () => sqs.schema(schema)`, or
   * with no event. When the queue has a schema, `sqs.schema()` must be given
   * the same schema.
   */
  target: SqsTarget<NoInfer<S>>;
};

/**
 * A Lambda that can read a queue whose schema has the type `S`. A queue with
 * no schema can be read by a declaration with any schema.
 */
export type SqsTarget<S extends StandardSchemaV1 | undefined> =
  | (() => {
      readonly "~lambda"?:
        | { kind: "none" }
        | {
            kind: "sqs";
            event: SqsEvent<[S] extends [undefined] ? any : S>;
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
export function eventSourceMapping<S extends StandardSchemaV1 | undefined>(
  config: EventSourceMappingConfig<S>,
): void {
  const { source, target, ...options } = config;
  whenLoaded(() => {
    const declaration = declarationOf(target);
    const event = declaration?.event;
    const queueName = queueNameOf(source);
    if (event?.kind === "sqs" && "queue" in event) {
      throw new Error(
        `eventSourceMapping() maps ${queueName} to the Lambda "${declaration!.id}", which maps ${event.queue === source ? "the same queue" : "a queue"} in its declaration, with event: () => sqs.bind(queue). Map the queue in one place: remove the eventSourceMapping() call, or declare the Lambda with event: () => sqs.schema(schema).`,
      );
    }
    const group = resolveLambda(target, "eventSourceMapping()", [
      "sqs",
      "none",
    ]);
    // A queue with no schema is allowed, as the function still validates.
    if (
      event?.kind === "sqs" &&
      source.schema !== undefined &&
      source.schema !== event.schema
    ) {
      throw new Error(
        `eventSourceMapping() maps ${queueName} to the Lambda "${group.id}", but the queue's schema is not the schema of the Lambda's event: () => sqs.schema(schema), so the function would validate the queue's messages with another schema. Give queue() and sqs.schema() the same schema, imported from a shared module.`,
      );
    }
    source["~subscribe"](group, options);
  });
}

function queueNameOf(source: SqsSource<any>): string {
  const id = (source as { id?: unknown }).id;
  return typeof id === "string" ? `the queue "${id}"` : "a queue";
}
