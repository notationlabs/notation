import type { Logger } from "./logger";

export async function runWithCliErrorHandling(
  fn: () => Promise<unknown>,
  opts: { logger: Logger; command: string },
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
    opts.logger.error(error);
    return 1;
  }
}
