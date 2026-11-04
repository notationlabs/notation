import {
  decodeRuntime,
  runtimeVariable,
  type DispatchEntry,
} from "@notation/aws.iac/shared";
import { addOutputSource } from "@notation/resource/outputs";
import type { Context } from "aws-lambda";
import { getHandlerKind } from "./handlers";

// The function's bundle imports this module before its handlers' modules, so
// the environment is added as an output source before any handler code
// reads infra.
addOutputSource(() => decodeRuntime(process.env[runtimeVariable]).outputs);

type Handler = (event: any, context: Context) => unknown;

type Target =
  { ok: true; name: string; event: unknown } | { ok: false; reason: string };

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
 *
 * If no export fits, the function throws. The dispatch map is read once, when
 * the function starts.
 */
export function createDispatcher(mod: Record<string, unknown>) {
  const dispatch = Object.values(
    decodeRuntime(process.env[runtimeVariable]).dispatch ?? {},
  );

  return async (event: unknown, context: Context) => {
    const target = findTarget(event, mod, dispatch);
    if (!target.ok) {
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

function findTarget(
  event: any,
  mod: Record<string, unknown>,
  dispatch: DispatchEntry[],
): Target {
  if (isScheduledInvocation(event)) {
    if (getHandlerKind(mod[event.export]) !== "schedule") {
      return {
        ok: false,
        reason: `The scheduled invocation names the export "${event.export}", which is not a schedule handler.`,
      };
    }
    return { ok: true, name: event.export, event: event.event };
  }
  const entry = dispatch.find(({ match }) => matches(match, event));
  if (entry) return { ok: true, name: entry.export, event };
  return { ok: false, reason: "The dispatch map has no entry for the event." };
}

function matches(match: DispatchEntry["match"], event: any): boolean {
  if ("apiId" in match) {
    return (
      match.apiId === event?.requestContext?.apiId &&
      match.routeKey === event.routeKey
    );
  }
  const record = Array.isArray(event?.Records) ? event.Records[0] : undefined;
  return (
    record?.eventSource === "aws:sqs" &&
    match.queueArn === record.eventSourceARN
  );
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
