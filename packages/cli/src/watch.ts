import chokidar from "chokidar";
import { createLoggerReconcilerSubscriber, deployApp } from "@notation/core";
import { compile } from "./compile";
import { defaultLogger, type Logger } from "./logger";

const dotFilesRe = /(^|[\/\\])\../;

export async function watch(
  entryPoint: string,
  logger: Logger = defaultLogger,
) {
  await compile(entryPoint, { watch: true, logger });

  const watcher = chokidar.watch("dist", {
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

    deployApp(
      entryPoint,
      false,
      undefined,
      undefined,
      undefined,
      createLoggerReconcilerSubscriber({ logger }),
    )
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
