import { createNdjsonEventEmitter, deployApp } from "@notation/core";
import { compile } from "./compile";
import { redirectStdoutToStderr } from "./stdio";

export type DeployCommandOptions = {
  json?: boolean;
};

export async function deploy(
  entryPoint: string,
  opts: DeployCommandOptions = {},
) {
  // In --json mode console output moves to stderr so stdout carries only the
  // NDJSON event stream; capture the real stdout for the emitter first.
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : undefined;

  await compile(entryPoint);
  console.log(`Deploying ${entryPoint}`);

  try {
    await deployApp(
      entryPoint,
      undefined,
      undefined,
      undefined,
      undefined,
      emit,
    );
  } catch (err: any) {
    if (err.name === "CredentialsProviderError") {
      console.log(
        "\nAWS credentials not found.",
        "\n\nEnsure you have a default profile set up in ~/.aws/credentials.",
        "\n\nIf using another profile run AWS_PROFILE=otherProfile notation deploy.\n",
      );
      process.exit(1);
    }
    console.log(err);
    process.exit(1);
  }
}
