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

/**
 * Values that infra passes to a function's code at runtime.
 */
export type LambdaRuntime = {
  /**
   * Keyed by the ID of the binding that added the entry, such as a route or
   * an event source mapping.
   */
  dispatch?: Record<string, DispatchEntry>;
  outputs?: Record<string, unknown>;
};

/**
 * The input that a schedule's rule sends to a function: the export to call,
 * and the original EventBridge event.
 */
export type ScheduledInvocation<Event = unknown> = {
  export: string;
  event: Event;
};

export function encodeRuntime(runtime: LambdaRuntime): string {
  return sortedJson.encode(runtime);
}

export function decodeRuntime(text: string | undefined): LambdaRuntime {
  if (!text) return {};
  return sortedJson.decode(text) as LambdaRuntime;
}
