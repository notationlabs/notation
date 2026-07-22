import {
  ResourceOperationPendingError,
  type ResourceOperationContext,
} from "@notation/resource";

type OperationStep = {
  run<T>(
    key: string,
    operation: () => T | Promise<T>,
  ): AsyncGenerator<unknown, T, unknown>;
  delay(key: string, delayMs: number): AsyncGenerator<unknown, void, unknown>;
};

export const DEFAULT_MAX_OPERATION_ATTEMPTS = 30;

export async function* runPendingOperation<T>(
  step: OperationStep,
  key: string,
  operation: (context?: ResourceOperationContext) => T | Promise<T>,
  maxAttempts = DEFAULT_MAX_OPERATION_ATTEMPTS,
): AsyncGenerator<unknown, T, unknown> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxOperationAttempts must be a positive integer");
  }

  let context: ResourceOperationContext | undefined;
  let pending: ResourceOperationPendingError | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return yield* step.run(`${key}:attempt:${attempt}`, () =>
        operation(context),
      );
    } catch (error) {
      if (!ResourceOperationPendingError.is(error)) throw error;

      pending = error;
      context = error.callbackContext;

      if (attempt + 1 < maxAttempts) {
        yield* step.delay(`${key}:retry-delay:${attempt}`, error.retryAfterMs);
      }
    }
  }

  throw new Error(
    `${pending?.message ?? "Resource operation remained pending"} after ${maxAttempts} attempts`,
    { cause: pending },
  );
}
