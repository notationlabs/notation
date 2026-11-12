import type { DurableObject } from "./durable-value";

/**
 * Data passed from one attempt of an operation to the next. The reconciler
 * records it with the error, so it must be a durable value.
 */
export type ResourceOperationContext = Readonly<DurableObject>;

/**
 * What deploy knows about a delete. A `delete` operation gets it when its
 * type sets `deleteTakesDependents`.
 */
export type ResourceDeletion = {
  /**
   * The resources of the deployment whose state records depend on the
   * deleted resource, with the params in their records. Deploy updates or
   * deletes each of them in the same run: it updates a dependent of a
   * replaced resource when it reaches it, and destroy and the orphan sweep
   * delete a dependent too. So a provider that refuses to delete a resource
   * that others refer to can force the delete when every reference comes
   * from one of these.
   */
  dependents: readonly {
    id: string;
    type: string;
    params: Readonly<Record<string, unknown>>;
  }[];
};

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

  /**
   * True when the provider refused the request because of a rate limit. A
   * throttled `read` says nothing about whether the resource exists.
   */
  readonly throttled: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      retryAfterMs: number;
      callbackContext?: ResourceOperationContext;
      throttled?: boolean;
    },
  ) {
    super(message, options);
    this.name = "ResourceOperationPendingError";
    this.retryAfterMs = options.retryAfterMs;
    this.callbackContext = options.callbackContext;
    this.throttled = options.throttled ?? false;

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

/**
 * A `create` operation throws this error when it cannot tell whether the
 * provider made the resource, for example after a timeout.
 *
 * The reconciler looks the resource up before it calls `create` again. A
 * resource that cannot be looked up fails the create.
 */
export class ResourceCreationUnknownError extends Error {
  readonly _tag = "ResourceCreationUnknownError" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResourceCreationUnknownError";
  }

  static is(error: unknown): error is ResourceCreationUnknownError {
    return hasTag(error, "ResourceCreationUnknownError");
  }
}

/**
 * A `create` operation throws this error when the provider refuses the create
 * because a resource with the same key already exists, for example IAM's
 * `EntityAlreadyExists`.
 *
 * The reconciler takes the resource over only with proof that one of
 * Notation's own creates made it. The resource's `ownership` says
 * how that is proved. Otherwise the create fails.
 */
export class ResourceAlreadyExistsError extends Error {
  readonly _tag = "ResourceAlreadyExistsError" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResourceAlreadyExistsError";
  }

  static is(error: unknown): error is ResourceAlreadyExistsError {
    return hasTag(error, "ResourceAlreadyExistsError");
  }
}

export type ResourceOperationSignal =
  | ResourceNotFoundError
  | ResourceOperationPendingError
  | ResourceCreationUnknownError
  | ResourceAlreadyExistsError;

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
