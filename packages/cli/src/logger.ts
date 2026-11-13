import { scrubError, type Logger } from "@notation/core";

const scrubbedLoggers = new WeakSet<Logger>();

function scrubArgs(args: unknown[]): unknown[] {
  return args.map((arg) => scrubError(arg));
}

export function createScrubbedLogger(logger: Logger): Logger {
  if (scrubbedLoggers.has(logger)) {
    return logger;
  }
  const wrapped: Logger = {
    info: (...args: unknown[]) => logger.info(...scrubArgs(args)),
    warn: (...args: unknown[]) => logger.warn(...scrubArgs(args)),
    error: (...args: unknown[]) => logger.error(...scrubArgs(args)),
  };
  scrubbedLoggers.add(wrapped);
  return wrapped;
}

export const defaultLogger: Logger = createScrubbedLogger({
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
});

export type { Logger };
