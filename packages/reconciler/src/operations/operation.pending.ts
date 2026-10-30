import {
  ResourceOperationPendingError,
  type DurableObject,
  type ResourceOperationContext,
} from "@notation/resource";
import type { StepRunner } from "./operation.types";

export const DEFAULT_MAX_OPERATION_ATTEMPTS = 30;

/**
 * Runs `attempt` until it does not throw a `ResourceOperationPendingError`,
 * waiting `retryAfterMs` between attempts and passing each attempt the
 * callback context of the one before. `attempt` must put its attempt number
 * in its step keys.
 */
export async function* retryPending<T>(
  step: StepRunner,
  key: string,
  attempt: (
    n: number,
    context?: ResourceOperationContext,
  ) => AsyncGenerator<unknown, T, unknown>,
  maxAttempts = DEFAULT_MAX_OPERATION_ATTEMPTS,
): AsyncGenerator<unknown, T, unknown> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxOperationAttempts must be a positive integer");
  }

  let context: ResourceOperationContext | undefined;
  let pending: ResourceOperationPendingError | undefined;

  for (let n = 0; n < maxAttempts; n += 1) {
    try {
      return yield* attempt(n, context);
    } catch (error) {
      if (!ResourceOperationPendingError.is(error)) throw error;

      pending = error;
      context = error.callbackContext;

      if (n + 1 < maxAttempts) {
        yield* step.delay(`${key}:retry-delay:${n}`, error.retryAfterMs);
      }
    }
  }

  throw new Error(
    `${pending?.message ?? "Resource operation remained pending"} after ${maxAttempts} attempts`,
    { cause: pending },
  );
}

/** Retries a pending operation, running each attempt as a `step.run`. */
export function runPendingOperation(
  step: StepRunner,
  key: string,
  operation: (
    context?: ResourceOperationContext,
  ) => Promise<DurableObject | void>,
  maxAttempts = DEFAULT_MAX_OPERATION_ATTEMPTS,
): AsyncGenerator<unknown, DurableObject | void, unknown> {
  return retryPending(
    step,
    key,
    (n, context) => step.run(`${key}:attempt:${n}`, () => operation(context)),
    maxAttempts,
  );
}
