import * as v from "valibot";
import { sortedJson } from "@notation/utils";

/**
 * The environment variable that holds a function's encoded `Runtime` map.
 * This entry point doesn't import the AWS SDK, so function code can use it.
 */
export const runtimeVariable = "NOTATION_RUNTIME";

/** Matches an HTTP API request by the API's ID and the route key. */
export type ApiRouteMatch = { apiId: string; routeKey: string };

/** Matches SQS messages by the ARN of the queue they came from. */
export type SqsQueueMatch = { queueArn: string };

export type DispatchMatch = ApiRouteMatch | SqsQueueMatch;

/** Sends events that match `match` to the module export named `export`. */
export type DispatchEntry = { export: string; match: DispatchMatch };

/** Values that infra passes to a function's code at runtime. */
export type LambdaRuntime = {
  /**
   * Keyed by the ID of the binding that added the entry, such as a route or
   * an event source mapping.
   */
  dispatch?: Record<string, DispatchEntry>;
};

/**
 * The input that a schedule's rule sends to a function: the export to call,
 * and the original EventBridge event.
 */
export type ScheduledInvocation<Event = unknown> = {
  export: string;
  event: Event;
};

const dispatchMatchValue = v.union([
  v.object({ apiId: v.string(), routeKey: v.string() }),
  v.object({ queueArn: v.string() }),
]);

export const runtimeValue = v.object({
  dispatch: v.optional(
    v.record(
      v.string(),
      v.object({ export: v.string(), match: dispatchMatchValue }),
    ),
  ),
});

/** Encodes the runtime map for the environment variable, as sorted JSON. */
export function encodeRuntime(runtime: LambdaRuntime): string {
  return sortedJson.encode(runtime);
}

/** Throws when `text` is not a runtime map. */
export function decodeRuntime(text: string | undefined): LambdaRuntime {
  if (!text) return {};
  const value = sortedJson.decode(text);
  // `v.object` accepts an array.
  const result = v.safeParse(runtimeValue, value);
  if (Array.isArray(value) || !result.success) {
    throw new Error(`${runtimeVariable} does not hold a valid runtime map`);
  }
  return result.output;
}
