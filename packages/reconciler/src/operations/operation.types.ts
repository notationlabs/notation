import type { BaseResource, ErrorMatcher, ResourceType } from "@notation/resource";
import type { State } from "@notation/state";

export type OperationName = "create" | "read" | "update" | "delete";

export type OperationLifecycleStatus =
  | "start"
  | "success"
  | "error"
  | "skip"
  | "dry-run";

export type OperationLifecycleEvent = {
  level: "info" | "error";
  event: "reconciler.operation.lifecycle";
  operation: OperationName;
  status: OperationLifecycleStatus;
  resourceId: string;
  resourceType: ResourceType;
  reason?: string;
  errorName?: string;
  errorMessage?: string;
};

export type OperationEventEmitter = (
  event: OperationLifecycleEvent,
) => void | Promise<void>;

export type PollOptions = {
  maxAttempts: number;
  retryInterval: number;
};

export type StepRunner = {
  run<T>(fn: () => T | Promise<T>): AsyncGenerator<unknown, T, unknown>;
  run<T>(
    key: string,
    fn: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown>;
  poll(
    opts: PollOptions,
    predicate: () => boolean | Promise<boolean>,
  ): AsyncGenerator<unknown, void, unknown>;
  poll(
    key: string,
    opts: PollOptions,
    predicate: () => boolean | Promise<boolean>,
  ): AsyncGenerator<unknown, void, unknown>;
  delay(ms: number): AsyncGenerator<unknown, void, unknown>;
  delay(key: string, ms: number): AsyncGenerator<unknown, void, unknown>;
};

export type ResourceOperationBaseParams = {
  resource: BaseResource;
  state: Pick<State, "get" | "update" | "delete">;
  dryRun?: boolean;
  emit?: OperationEventEmitter;
  retryOptions?: PollOptions;
  readPollOptions?: PollOptions;
};

export type CreateResourceParams = ResourceOperationBaseParams;

export type ReadResourceParams = ResourceOperationBaseParams;

export type UpdateResourceParams = ResourceOperationBaseParams & {
  patch: Record<string, unknown>;
};

export type DeleteResourceParams = ResourceOperationBaseParams;

export const DEFAULT_RETRY_OPTIONS: PollOptions = {
  maxAttempts: 10,
  retryInterval: 1_000,
};

export const DEFAULT_READ_POLL_OPTIONS: PollOptions = {
  maxAttempts: 30,
  retryInterval: 1_000,
};

export function matchError(
  err: unknown,
  matchers: ErrorMatcher[] | undefined,
): ErrorMatcher | undefined {
  if (!matchers || matchers.length === 0) return undefined;

  const name =
    typeof err === "object" && err && "name" in err
      ? String((err as { name?: unknown }).name)
      : undefined;
  const message =
    typeof err === "object" && err && "message" in err
      ? String((err as { message?: unknown }).message)
      : undefined;

  return matchers.find((matcher) => {
    if (matcher.name !== name) return false;
    if (matcher.message && matcher.message !== message) return false;
    return true;
  });
}

export function getErrorDetails(err: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(err),
  };
}

export async function emitLifecycleEvent(
  params: ResourceOperationBaseParams,
  operation: OperationName,
  status: OperationLifecycleStatus,
  extra: Partial<OperationLifecycleEvent> = {},
) {
  if (!params.emit) return;

  await params.emit({
    level: status === "error" ? "error" : "info",
    event: "reconciler.operation.lifecycle",
    operation,
    status,
    resourceId: params.resource.id,
    resourceType: params.resource.type,
    ...extra,
  });
}
