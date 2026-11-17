import { findReportedError, scrubError } from "@notation/core";
import type { Logger } from "./logger";

export async function runWithErrorHandling(
  fn: () => Promise<unknown>,
  opts: {
    logger: Logger;
    command: string;
    // Prints every error in full, with its stack.
    debug?: boolean;
  },
): Promise<0 | 1> {
  try {
    await fn();
    return 0;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "CredentialsProviderError") {
      opts.logger.error(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        `\n\nIf using another profile run AWS_PROFILE=otherProfile notation ${opts.command}.\n`,
      );
      return 1;
    }
    const scrubbed = scrubError(error);
    const reported = opts.debug ? undefined : findReportedError(scrubbed);
    if (!reported) {
      opts.logger.error(scrubbed);
      return 1;
    }
    // The error event has printed the error. An error that wraps it adds
    // its own message, such as the commands to run.
    const { operation, credential, resourceId } = reported.reportedOperation;
    const target = credential ? `${credential} of ${resourceId}` : resourceId;
    opts.logger.error(
      `\nnotation ${opts.command} stopped because ${operation} ${target} failed.`,
    );
    if (reported !== scrubbed) opts.logger.error((scrubbed as Error).message);
    return 1;
  }
}
