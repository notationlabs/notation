import type { ErrorMatcher } from "@notation/resource";
import type {
  OperationLifecycleEvent,
  OperationLifecycleStatus,
  OperationName,
} from "./events";

export type PollOptions = {
  maxAttempts: number;
  retryInterval: number;
};

export const DEFAULT_RETRY_OPTIONS: PollOptions = {
  maxAttempts: 10,
  retryInterval: 1_000,
};

export const DEFAULT_READ_POLL_OPTIONS: PollOptions = {
  maxAttempts: 30,
  retryInterval: 1_000,
};

export function matchError(
  error: unknown,
  matchers: ErrorMatcher[] | undefined,
): ErrorMatcher | undefined {
  if (!matchers || matchers.length === 0) return undefined;

  const name =
    typeof error === "object" && error && "name" in error
      ? String((error as { name?: unknown }).name)
      : undefined;
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message)
      : undefined;

  return matchers.find((matcher) => {
    if (matcher.name !== name) return false;
    if (matcher.message && matcher.message !== message) return false;
    return true;
  });
}

export function createLifecycleEvent(params: {
  operation: OperationName;
  status: OperationLifecycleStatus;
  resourceId: string;
  resourceType: OperationLifecycleEvent["resourceType"];
  reason?: string;
  error?: unknown;
}): OperationLifecycleEvent {
  const error = params.error;
  const details =
    error === undefined
      ? {}
      : error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : { errorName: "UnknownError", errorMessage: String(error) };

  return {
    level: params.status === "error" ? "error" : "info",
    event: "reconciler.operation.lifecycle",
    operation: params.operation,
    status: params.status,
    resourceId: params.resourceId,
    resourceType: params.resourceType,
    ...(params.reason ? { reason: params.reason } : {}),
    ...details,
  };
}
