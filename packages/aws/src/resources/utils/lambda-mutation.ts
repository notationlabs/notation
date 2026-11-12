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

/**
 * Returns true for Lambda's refusal to create a function, a policy
 * statement or an event source mapping that already exists. Lambda reports other conflicts, such as an
 * update in progress, with the same exception, so the message is checked
 * too.
 */
export function isLambdaAlreadyExists(error: unknown): boolean {
  return (
    error instanceof sdk.ResourceConflictException &&
    /already exist/i.test(error.message)
  );
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
