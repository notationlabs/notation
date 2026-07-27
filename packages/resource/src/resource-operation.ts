export type ResourceOperationContext = Readonly<Record<string, unknown>>;

export class ResourceNotFoundError extends Error {
  readonly _tag = "ResourceNotFoundError" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResourceNotFoundError";
  }

  static is(error: unknown): error is ResourceNotFoundError {
    return hasTag(error, "ResourceNotFoundError");
  }
}

export class ResourceOperationPendingError extends Error {
  readonly _tag = "ResourceOperationPendingError" as const;
  readonly retryAfterMs: number;
  readonly callbackContext?: ResourceOperationContext;

  constructor(
    message: string,
    options: ErrorOptions & {
      retryAfterMs: number;
      callbackContext?: ResourceOperationContext;
    },
  ) {
    super(message, options);
    this.name = "ResourceOperationPendingError";
    this.retryAfterMs = options.retryAfterMs;
    this.callbackContext = options.callbackContext;

    if (!Number.isFinite(options.retryAfterMs) || options.retryAfterMs < 0) {
      throw new RangeError("retryAfterMs must be a non-negative number");
    }
  }

  static is(error: unknown): error is ResourceOperationPendingError {
    return (
      hasTag(error, "ResourceOperationPendingError") &&
      "retryAfterMs" in error &&
      typeof error.retryAfterMs === "number"
    );
  }
}

export type ResourceOperationSignal =
  ResourceNotFoundError | ResourceOperationPendingError;

function hasTag<T extends string>(
  error: unknown,
  tag: T,
): error is Error & { _tag: T } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === tag
  );
}
