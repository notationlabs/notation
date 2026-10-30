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
export function isUncertainAwsError(error: unknown): boolean {
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
