import { ResourceCreationUnknownError } from "@notation/resource";

const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Returns true when an AWS call may have taken effect without a response
 * reaching the caller: the request timed out, the connection broke, or the
 * service answered with a server error.
 */
export function awsCallMayHaveTakenEffect(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code, $metadata } = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = $metadata?.httpStatusCode;
  if (status !== undefined) return status >= 500;
  return (
    name === "TimeoutError" ||
    (typeof code === "string" && NETWORK_ERROR_CODES.has(code))
  );
}

/**
 * Wraps an AWS `create` so that an error from a call that may have taken
 * effect is thrown as `ResourceCreationUnknownError`.
 */
export function awsCreate<Args extends unknown[], Result>(
  create: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await create(...args);
    } catch (error) {
      if (!awsCallMayHaveTakenEffect(error)) throw error;
      throw new ResourceCreationUnknownError(
        `AWS did not report whether the resource was created: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
}
