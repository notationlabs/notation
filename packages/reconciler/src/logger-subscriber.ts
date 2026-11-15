import type { ReconcilerEvent, ReconcilerEventEmitter } from "./events";

export type Logger = Pick<Console, "info" | "warn" | "error">;

export type LoggerReconcilerSubscriberOptions = {
  logger?: Logger;
};

// Prints each event as one line. `--json` gives the full event objects.
export function createLoggerReconcilerSubscriber(
  opts: LoggerReconcilerSubscriberOptions = {},
): ReconcilerEventEmitter {
  const logger = opts.logger ?? console;

  return async (event: ReconcilerEvent) => {
    logger[event.level](formatReconcilerEvent(event));
    if (
      event.event === "reconciler.operation.lifecycle" &&
      event.reason === "taken-over"
    ) {
      logger.info(
        `Took over ${event.resourceId}: it already existed, so deploy ` +
          `read it and now compares it with config`,
      );
    }
  };
}

export function formatReconcilerEvent(event: ReconcilerEvent): string {
  switch (event.event) {
    case "reconciler.operation.lifecycle": {
      let line = `${event.operation} ${event.status}: ${event.resourceId} (${event.resourceType})`;
      if (event.reason) line += ` reason=${event.reason}`;
      if (event.replacedDependency) {
        line += ` replacedDependency=${event.replacedDependency}`;
      }
      if (event.errorName || event.errorMessage) {
        line += ` error: ${[event.errorName, event.errorMessage].filter(Boolean).join(": ")}`;
      }
      return line;
    }
    case "reconciler.deploy.decision": {
      let line = `decision ${event.decision}: ${event.resourceId} (${event.resourceType})`;
      if (event.replaceFields?.length) {
        line += ` fields=${JSON.stringify(event.replaceFields)}`;
      }
      if (event.replaceOrder) line += ` order=${event.replaceOrder}`;
      if (event.placeholder) line += " placeholder";
      return line;
    }
    case "reconciler.drift.detected":
      return `drift detected: ${event.resourceId} (${event.resourceType}) diff=${JSON.stringify(event.diff)}`;
    case "reconciler.hold.waiting":
      return (
        `waiting: execution ${event.holderExecutionId} holds deployment ` +
        `${event.deploymentId} (this execution: ${event.executionId})`
      );
    case "reconciler.orphan-deletion.skipped": {
      let line =
        `${event.workflow} skipped delete: ${event.resourceId} ` +
        `(${event.resourceType}) reason=${event.reason}`;
      if (event.keptDependencies.length) {
        line += ` kept=${event.keptDependencies.join(",")}`;
      }
      return line;
    }
    case "reconciler.provider.load-failed":
      return `provider load failed: ${event.provider} error: ${event.errorMessage}`;
  }
}
