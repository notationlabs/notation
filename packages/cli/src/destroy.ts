import {
  destroyApp,
  resolveDeploymentId,
  type Deployment,
} from "@notation/core";
import { randomUUID } from "node:crypto";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";
import { createEventRenderer, type OutputMode } from "./output";

export type DestroyCommandOptions = {
  output?: OutputMode;
  executionId?: string;
  // Printed with the execution ID, such as `notation deploy`.
  resumeCommand?: string;
  logger?: Logger;
};

export async function destroy(
  deployment: Deployment,
  opts: DestroyCommandOptions = {},
) {
  const logger = opts.logger ?? defaultLogger;
  const emit = createEventRenderer(opts.output ?? "pretty", logger);

  await compile(deployment, { logger });
  logger.info(`Destroying ${resolveDeploymentId(deployment)}\n`);
  const executionId = opts.executionId ?? randomUUID();
  logger.info(`Execution ID ${executionId}`);
  if (opts.resumeCommand) {
    logger.info(
      `To resume after a crash, run ${opts.resumeCommand} --execution-id ${executionId}`,
    );
  }

  await destroyApp({ deployment, emit, executionId });
}
