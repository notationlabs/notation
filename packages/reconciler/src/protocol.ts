import type { ReconcilerEvent, ReconcilerEventEmitter } from "./events";

export const EVENT_STREAM_VERSION = 1 as const;

export type WireReconcilerEvent = ReconcilerEvent & {
  version: typeof EVENT_STREAM_VERSION;
};

export function encodeReconcilerEvent(event: ReconcilerEvent): string {
  return `${JSON.stringify({ version: EVENT_STREAM_VERSION, ...event })}\n`;
}

export function createNdjsonEventEmitter(
  write: (line: string) => void | Promise<void>,
): ReconcilerEventEmitter {
  return (event) => write(encodeReconcilerEvent(event));
}
