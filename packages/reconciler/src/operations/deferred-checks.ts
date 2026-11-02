import { SchemaStructureError, ValueValidationError } from "@notation/resource";

export type DeferredCheck = () => AsyncGenerator<unknown, void, unknown>;

/**
 * Runs the checks that follow a create or update, in order, and stops at the
 * first that fails. Returns its error when it is a `ValueValidationError` or
 * a `SchemaStructureError`, so that the caller can write the resource's
 * record before it throws. Any other error is thrown at once.
 */
export async function* firstDeferredError(
  checks: DeferredCheck[],
): AsyncGenerator<unknown, unknown, unknown> {
  for (const check of checks) {
    try {
      yield* check();
    } catch (error) {
      if (!ValueValidationError.is(error) && !SchemaStructureError.is(error)) {
        throw error;
      }
      return error;
    }
  }
  return undefined;
}
