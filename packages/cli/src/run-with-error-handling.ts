import type { Logger } from "./logger";

export async function runWithCliErrorHandling(
  fn: () => Promise<void>,
  opts: { logger: Logger; command: string },
): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      opts.logger.error(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        `\n\nIf using another profile run AWS_PROFILE=otherProfile notation ${opts.command}.\n`,
      );
      process.exit(1);
    }
    opts.logger.error(err);
    process.exit(1);
  }
}
