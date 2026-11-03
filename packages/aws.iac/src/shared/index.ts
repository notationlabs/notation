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

/**
 * Encodes the runtime map for the environment variable. Lambda allows 4 KB
 * for all of a function's variables, so the encoding is compact:
 *
 * - `r` holds routes as `[export, apiId, routeKey]`.
 * - `q` holds queue subscriptions as `[export, queueArn]`.
 */
export function encodeRuntime(runtime: LambdaRuntime): string {
  const encoded: EncodedRuntime = {};
  for (const [key, entry] of Object.entries(runtime.dispatch ?? {})) {
    const { export: name, match } = entry;
    if ("queueArn" in match) {
      (encoded.q ??= {})[key] = [name, match.queueArn];
    } else {
      (encoded.r ??= {})[key] = [name, match.apiId, match.routeKey];
    }
  }
  return sortedJson.encode(encoded);
}

/** Throws when `text` is not a runtime map that `encodeRuntime` made. */
export function decodeRuntime(text: string | undefined): LambdaRuntime {
  if (!text) return {};
  const encoded = sortedJson.decode(text) as EncodedRuntime;
  if (!isRecord(encoded)) throw invalidRuntime();
  const runtime: LambdaRuntime = {};
  const dispatch: Record<string, DispatchEntry> = {};
  for (const [key, entry] of Object.entries(encoded.r ?? {})) {
    if (!isStrings(entry, 3)) throw invalidRuntime();
    dispatch[key] = {
      export: entry[0],
      match: { apiId: entry[1], routeKey: entry[2] },
    };
  }
  for (const [key, entry] of Object.entries(encoded.q ?? {})) {
    if (!isStrings(entry, 2)) throw invalidRuntime();
    dispatch[key] = { export: entry[0], match: { queueArn: entry[1] } };
  }
  if (Object.keys(dispatch).length > 0) runtime.dispatch = dispatch;
  return runtime;
}

type EncodedRuntime = {
  r?: Record<string, [string, string, string]>;
  q?: Record<string, [string, string]>;
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === "string")
  );
}

function invalidRuntime() {
  return new Error(`${runtimeVariable} does not hold a valid runtime map`);
}
