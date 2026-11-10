import * as sdk from "@aws-sdk/client-lambda";
import { ResourceOperationPendingError } from "@notation/resource";

/**
 * Runs a Lambda API call. When the call fails because a new role has not
 * propagated through IAM yet, throws a pending error so the reconciler
 * retries.
 */
export async function runLambdaMutation<T>(
  mutation: () => Promise<T>,
): Promise<T> {
  try {
    return await mutation();
  } catch (error) {
    if (isIamPropagationFailure(error)) {
      throw new ResourceOperationPendingError(
        "Waiting for IAM role to propagate",
        { retryAfterMs: 1_000, cause: error },
      );
    }
    throw error;
  }
}

function isIamPropagationFailure(
  error: unknown,
): error is sdk.InvalidParameterValueException {
  if (!(error instanceof sdk.InvalidParameterValueException)) return false;
  return (
    error.message.startsWith(
      "The role defined for the function cannot be assumed by Lambda.",
    ) ||
    error.message.startsWith(
      "The provided execution role does not have permissions",
    ) ||
    error.message.startsWith(
      "The function execution role does not have permissions",
    )
  );
}
