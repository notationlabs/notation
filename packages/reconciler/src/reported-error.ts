import type { OperationName } from "./events";

/** The operation whose error event reported an error. */
export type ReportedOperation = {
  operation: OperationName;
  resourceId: string;
  credential?: string;
};

type ReportedError = Error & { reportedOperation: ReportedOperation };

// An own field, because the durable runtime gives back a copy of a thrown
// error with only its own fields. A later report overwrites an earlier one,
// so a create that fails in its nested read names the create.
export function markReported(error: unknown, operation: ReportedOperation) {
  if (error instanceof Error && Object.isExtensible(error)) {
    (error as ReportedError).reportedOperation = operation;
  }
}

/**
 * Returns `error`, or the first error in its cause chain, that an error event
 * has reported. A caller can print a short line for it instead of the error.
 */
export function findReportedError(error: unknown): ReportedError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (Object.hasOwn(current, "reportedOperation")) {
      return current as ReportedError;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
