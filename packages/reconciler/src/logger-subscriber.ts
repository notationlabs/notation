import type { ReconcilerEvent, ReconcilerEventEmitter } from "./events";

export type Logger = Pick<Console, "info" | "warn" | "error">;

export type LoggerReconcilerSubscriberOptions = {
  logger?: Logger;
};

export function createLoggerReconcilerSubscriber(
  opts: LoggerReconcilerSubscriberOptions = {},
): ReconcilerEventEmitter {
  const logger = opts.logger ?? console;

  return async (event: ReconcilerEvent) => {
    if (event.level === "error") {
      logger.error(event.event, event);
      return;
    }

    if (event.level === "warn") {
      logger.warn(event.event, event);
      return;
    }

    logger.info(event.event, event);
  };
}
