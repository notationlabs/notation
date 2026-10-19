import chokidar from "chokidar";
import { randomUUID } from "node:crypto";
import { filePaths } from "@notation/core";
import { compile } from "./compile";
import { deployInChild } from "./deploy-child";
import { defaultLogger, type Logger } from "./logger";

const dotFilesRe = /(^|[\/\\])\../;

export async function watch(
  entryPoint: string,
  logger: Logger = defaultLogger,
) {
  await compile(entryPoint, { watch: true, logger });

  const watcher = chokidar.watch(filePaths.dist.dir(), {
    ignored: dotFilesRe,
    persistent: true,
  });

  watcher.on("all", debounceDeploy);

  let isDeploying = false;
  let deployQueued = false;
  let timeoutId: NodeJS.Timeout;
  const debounceTime = 500;

  function debounceDeploy() {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      triggerDeploy();
    }, debounceTime);
  }

  function triggerDeploy() {
    if (isDeploying) {
      deployQueued = true;
      return;
    }

    isDeploying = true;

    // The child logs the execution ID itself.
    const executionId = randomUUID();
    // A fresh process per deploy: importing the rebuilt infra in this
    // long-lived process would leak a copy of the bundle every time.
    deployInChild({ entryPoint, executionId, logger })
      .then(() => {
        isDeploying = false;
        if (deployQueued) {
          deployQueued = false;
          triggerDeploy();
        }
      })
      .catch((err) => {
        logger.error(err);
        isDeploying = false;
      });
  }
}
