import {
  decodeRuntime,
  runtimeVariable,
  type DispatchEntry,
} from "@notation/aws.iac/shared";
import type { Context } from "aws-lambda";
import { getHandlerKind, type HandlerKind } from "./handlers";

type Handler = (event: any, context: Context) => unknown;

/**
 * Makes the single entry point of a runtime module's Lambda function. It sends
 * each event to one export of the module:
 *
 * 1. A scheduled invocation goes to the export that it names. Anyone allowed
 *    to invoke the function can send this shape, so the export must be a
 *    schedule handler.
 * 2. An HTTP API request goes to the export that the dispatch map gives for
 *    its API and route key.
 * 3. SQS messages go to the export that the dispatch map gives for their
 *    queue.
 * 4. An event with no dispatch entry goes to the module's only handler of the
 *    event's kind. DynamoDB streams have no dispatch entries, so they always
 *    take this path. This path also hides a wrong or missing dispatch map
 *    until the module has a second handler of that kind.
 *
 * Only exports made with `handle.*` count as handlers. If no handler fits, the
 * function throws. The dispatch map is read once, when the function starts.
 */
export function createDispatcher(mod: Record<string, unknown>) {
  const dispatch = Object.values(
    decodeRuntime(process.env[runtimeVariable]).dispatch ?? {},
  );
  const handlersByKind = new Map<HandlerKind, string[]>();
  for (const name of Object.keys(mod)) {
    const kind = getHandlerKind(mod[name]);
    if (kind)
      handlersByKind.set(kind, [...(handlersByKind.get(kind) ?? []), name]);
  }

  return async (event: unknown, context: Context) => {
    const target = findTarget(event, dispatch, handlersByKind);
    if ("reason" in target) {
      throw new Error(
        `No export of this module handles the event (${describeEvent(event)}). ${target.reason}`,
      );
    }
    const handler = mod[target.name];
    if (typeof handler !== "function") {
      throw new Error(
        `The event is dispatched to the export "${target.name}", but the module has no handler with that name.`,
      );
    }
    return (handler as Handler)(target.event, context);
  };
}

type Target =
  { name: string; event: unknown } | { name?: undefined; reason: string };

function findTarget(
  event: any,
  dispatch: DispatchEntry[],
  handlersByKind: Map<HandlerKind, string[]>,
): Target {
  if (isScheduledInvocation(event)) {
    if (!handlersByKind.get("schedule")?.includes(event.export)) {
      return {
        reason: `The scheduled invocation names the export "${event.export}", which is not a schedule handler.`,
      };
    }
    return { name: event.export, event: event.event };
  }
  const kind = eventKind(event);
  if (!kind) {
    return {
      reason: "Its shape doesn't match any kind of event that a handler takes.",
    };
  }
  const entry = dispatch.find(({ match }) => matches(match, kind, event));
  if (entry) return { name: entry.export, event };

  const handlers = handlersByKind.get(kind) ?? [];
  if (handlers.length === 1) return { name: handlers[0]!, event };
  return {
    reason:
      handlers.length === 0
        ? `The module has no ${kind} handler, and the dispatch map has no entry for the event.`
        : `The dispatch map has no entry for the event, and the module has ${handlers.length} ${kind} handlers: ${handlers.join(", ")}.`,
  };
}

function eventKind(event: any): HandlerKind | undefined {
  if (
    typeof event?.requestContext?.apiId === "string" &&
    typeof event.routeKey === "string"
  ) {
    return "api";
  }
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  if (record?.eventSource === "aws:sqs") return "sqs";
  if (record?.eventSource === "aws:dynamodb") return "dynamodb";
  if (event?.["detail-type"] === "Scheduled Event") return "schedule";
  return undefined;
}

function matches(
  match: DispatchEntry["match"],
  kind: HandlerKind,
  event: any,
): boolean {
  if (kind === "api" && "apiId" in match) {
    return (
      match.apiId === event.requestContext.apiId &&
      match.routeKey === event.routeKey
    );
  }
  if (kind === "sqs" && "queueArn" in match) {
    return match.queueArn === event.Records[0].eventSourceARN;
  }
  return false;
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
  if (isScheduledInvocation(event)) {
    return `scheduled invocation of ${event.export}`;
  }
  if (typeof event?.routeKey === "string") {
    return `HTTP API route ${event.routeKey} on API ${event.requestContext?.apiId}`;
  }
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  if (record?.eventSourceARN) {
    return `${record.eventSource} event from ${record.eventSourceARN}`;
  }
  if (typeof event?.["detail-type"] === "string") {
    return `EventBridge ${event["detail-type"]}`;
  }
  return "unrecognised event";
}
