import type { ReconcilerEvent, ReconcilerEventEmitter } from "./reconciler";

export type ConsoleLike = Pick<Console, "info" | "warn" | "error">;

export type ConsoleReconcilerSubscriberOptions = {
  console?: ConsoleLike;
};

export function createConsoleReconcilerSubscriber(
  opts: ConsoleReconcilerSubscriberOptions = {},
): ReconcilerEventEmitter {
  const logger = opts.console ?? console;

  return async (event: ReconcilerEvent) => {
    if (event.level === "error") {
      logger.error(event.event, event);
      return;
    }

    if (event.event === "reconciler.orphan-deletion.skipped") {
      logger.warn(event.event, event);
      return;
    }

    logger.info(event.event, event);
  };
}
