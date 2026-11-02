import {
  decodeRuntime,
  runtimeVariable,
  type DispatchEntry,
} from "@notation/aws.iac/shared";
import type { Context } from "aws-lambda";
import { isHandler } from "./handlers";

type Handler = (event: any, context: Context) => unknown;

/**
 * Makes the single entry point of a runtime module's Lambda. It sends each
 * event to one of the module's exports:
 *
 * 1. A scheduled invocation names its export, and carries the original event.
 * 2. An HTTP API request goes to the export that the dispatch map gives for
 *    its API and route key.
 * 3. SQS messages go to the export that the dispatch map gives for their
 *    queue.
 * 4. Any other event, or one that the dispatch map has no entry for, goes to
 *    the module's only handler, if it has exactly one. Only exports made with
 *    `handle.*` count as handlers.
 *
 * The dispatch map is read from the environment once, when the function
 * starts.
 */
export function createDispatcher(mod: Record<string, unknown>) {
  const dispatch = Object.values(
    decodeRuntime(process.env[runtimeVariable]).dispatch ?? {},
  );
  const handlers = Object.keys(mod).filter((name) => isHandler(mod[name]));

  return async (event: unknown, context: Context) => {
    const target = findTarget(event, dispatch);
    const name =
      target?.name ?? (handlers.length === 1 ? handlers[0] : undefined);
    if (name === undefined) {
      throw new Error(
        `No export of this module handles the event (${describeEvent(event)}). The dispatch map has ${dispatch.length} entries.`,
      );
    }
    const handler = mod[name];
    if (typeof handler !== "function") {
      throw new Error(
        `The event is dispatched to the export "${name}", but the module has no handler with that name.`,
      );
    }
    return (handler as Handler)(target?.event ?? event, context);
  };
}

function findTarget(
  event: any,
  dispatch: DispatchEntry[],
): { name: string | undefined; event: unknown } | undefined {
  if (isScheduledInvocation(event)) {
    return { name: event.export, event: event.event };
  }
  const apiId = event?.requestContext?.apiId;
  if (typeof apiId === "string" && typeof event.routeKey === "string") {
    const entry = dispatch.find(
      ({ match }) =>
        "apiId" in match &&
        match.apiId === apiId &&
        match.routeKey === event.routeKey,
    );
    return { name: entry?.export, event };
  }
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  if (record?.eventSource === "aws:sqs") {
    const entry = dispatch.find(
      ({ match }) =>
        "queueArn" in match && match.queueArn === record.eventSourceARN,
    );
    return { name: entry?.export, event };
  }
  return undefined;
}

function isScheduledInvocation(
  event: any,
): event is { export: string; event: unknown } {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof event.export === "string" &&
    "event" in event
  );
}

function describeEvent(event: any): string {
  if (typeof event?.routeKey === "string") {
    return `HTTP API route ${event.routeKey} on API ${event.requestContext?.apiId}`;
  }
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  if (record?.eventSourceARN) {
    return `${record.eventSource} event from ${record.eventSourceARN}`;
  }
  return "unrecognised event";
}
