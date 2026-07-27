/** Plain data passed from one attempt of an operation to the next. */
export type ResourceOperationContext = Readonly<Record<string, unknown>>;

/**
 * A `read` operation throws this error when no resource exists for its key.
 */
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

/**
 * An operation throws this error when it has not finished.
 *
 * The reconciler waits for `retryAfterMs`, then calls the same operation again
 * with `callbackContext`.
 */
export class ResourceOperationPendingError extends Error {
  readonly _tag = "ResourceOperationPendingError" as const;

  /** Milliseconds to wait before the next attempt. */
  readonly retryAfterMs: number;

  /** Plain data passed to the next attempt of the same operation. */
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
