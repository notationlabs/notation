import chokidar from "chokidar";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { configPath, filePaths, type Deployment } from "@notation/core";
import { compile } from "./compile";
import { deployInChild } from "./deploy-child";
import { defaultLogger, type Logger } from "./logger";

const dotFilesRe = /(^|[\/\\])\../;

export type WatchOptions = {
  logger?: Logger;
  exit?: (code: number) => void;
};

/**
 * Compiles the entry in watch mode and redeploys on each rebuild. Resolves
 * once the watchers are ready.
 *
 * `watch` uses the config it started with. When the config file changes,
 * `watch` waits for a running deploy to finish and then exits with code 1, so
 * the user restarts it with the new config.
 */
export async function watch(
  deployment: Deployment,
  { logger = defaultLogger, exit = process.exit }: WatchOptions = {},
) {
  let isDeploying = false;
  let deployQueued = false;
  let stopping = false;
  let timeoutId: NodeJS.Timeout;
  const debounceTime = 500;
  let buildsOk = true;
  // Set when a deploy was skipped because a build failed, so that the next
  // build that succeeds deploys even if it writes nothing new to `dist`.
  let deployBlocked = false;

  await compile(deployment, {
    watch: true,
    logger,
    onBuildStatus: (ok) => {
      buildsOk = ok;
      if (ok && deployBlocked) {
        deployBlocked = false;
        debounceDeploy();
      }
    },
  });

  const watcher = chokidar.watch(filePaths.dist.dir(), {
    ignored: dotFilesRe,
    persistent: true,
  });
  const configWatcher = chokidar.watch(configPath(), {
    ignoreInitial: true,
  });

  watcher.on("all", debounceDeploy);
  configWatcher.on("all", stop);

  function debounceDeploy() {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      triggerDeploy();
    }, debounceTime);
  }

  function triggerDeploy() {
    if (stopping) return;
    if (!buildsOk) {
      if (!deployBlocked) {
        logger.info(
          "A build failed, so watch didn't deploy. Watch deploys after the builds succeed.",
        );
      }
      deployBlocked = true;
      return;
    }
    if (isDeploying) {
      deployQueued = true;
      return;
    }

    isDeploying = true;

    // The child logs the execution ID itself.
    const executionId = randomUUID();
    // A fresh process per deploy: importing the rebuilt infra in this
    // long-lived process would leak a copy of the bundle every time.
    deployInChild({ deployment, executionId, logger })
      .then(() => {
        isDeploying = false;
        if (stopping) {
          void close();
        } else if (deployQueued) {
          deployQueued = false;
          triggerDeploy();
        }
      })
      .catch((err) => {
        logger.error(err);
        isDeploying = false;
        if (stopping) void close();
      });
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timeoutId);
    logger.error(
      `${path.basename(configPath())} changed. Restart watch to use the new config.`,
    );
    if (!isDeploying) void close();
  }

  async function close() {
    await Promise.all([watcher.close(), configWatcher.close()]);
    exit(1);
  }

  await Promise.all([once(watcher, "ready"), once(configWatcher, "ready")]);
}
