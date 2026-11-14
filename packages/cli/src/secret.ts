import { deleteSecret, setSecret, type Deployment } from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import {
  canPrompt,
  confirm,
  promptHidden,
  readStdin,
  type PromptStreams,
} from "./prompt";

export type SecretCommandOptions = {
  logger?: Logger;
  streams?: PromptStreams;
};

/**
 * Sets a secret's value in its store. The value comes from a hidden prompt
 * on a terminal, and from stdin otherwise. It is never an argument, so it
 * stays out of shell history and `ps`.
 */
export async function secretSet(
  deployment: Deployment,
  id: string,
  opts: SecretCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  await compile(deployment, { logger });
  await setSecret({
    deployment,
    id,
    readValue: async () => {
      const value = canPrompt(opts.streams?.input)
        ? await promptHidden(
            `Value of the secret ${id} for stage ${deployment.stage}: `,
            opts.streams,
          )
        : await readStdin(opts.streams?.input);
      if (value === "") throw new Error(`No value was given for ${id}.`);
      return value;
    },
  });
  logger.info(`Set the secret ${id} for stage ${deployment.stage}.`);
}

/**
 * Deletes a secret from its store. It asks first on a terminal, and needs
 * `yes` without one.
 */
export async function secretDelete(
  deployment: Deployment,
  id: string,
  opts: SecretCommandOptions & { yes?: boolean } = {},
) {
  const logger = opts.logger ?? defaultLogger;
  await compile(deployment, { logger });
  const deleted = await deleteSecret({
    deployment,
    id,
    confirm: async () => {
      if (opts.yes) return true;
      if (!canPrompt(opts.streams?.input)) {
        throw new Error(
          `Deleting ${id} needs confirmation. Run the command in a terminal, or pass --yes.`,
        );
      }
      return confirm(
        `Delete the secret ${id} for stage ${deployment.stage}?`,
        opts.streams,
      );
    },
  });
  logger.info(
    deleted
      ? `Deleted the secret ${id} for stage ${deployment.stage}. The next \`notation deploy\` creates it again. \`notation watch\` doesn't, and a Worker that binds it fails to upload until it exists.`
      : `Kept the secret ${id}.`,
  );
}
