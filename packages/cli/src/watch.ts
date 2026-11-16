import chokidar from "chokidar";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { bundleInputFiles } from "@notation/build";
import { configPath, filePaths, type Deployment } from "@notation/core";
import { compile } from "./compile";
import { deployInChild } from "./deploy-child";
import { defaultLogger, type Logger } from "./logger";

const dotFilesRe = /(^|[\/\\])\../;
const nodeModulesRe = /[\/\\]node_modules[\/\\]/;

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
  const closeCompile = await compile(deployment, { watch: true, logger });

  const watcher = chokidar.watch(filePaths.dist.dir(), {
    ignored: dotFilesRe,
    persistent: true,
  });
  const configWatcher = chokidar.watch(configPath(), {
    ignoreInitial: true,
  });
  // The files that the bundles read, from their inputs files. A bundle's
  // entry is usually in a package, which the infra build doesn't watch.
  const bundleWatcher = chokidar.watch([], { ignoreInitial: true });
  let bundleInputs = new Set<string>();

  watcher.on("all", debounceDeploy);
  configWatcher.on("all", stop);
  bundleWatcher.on("all", debounceDeploy);
  watchBundleInputs();

  // A file in node_modules is not watched. A linked workspace package
  // resolves to its real path outside node_modules, so it is watched.
  function watchBundleInputs() {
    const files = new Set(
      bundleInputFiles().filter((file) => !nodeModulesRe.test(file)),
    );
    const added = [...files].filter((file) => !bundleInputs.has(file));
    const removed = [...bundleInputs].filter((file) => !files.has(file));
    if (added.length > 0) bundleWatcher.add(added);
    if (removed.length > 0) bundleWatcher.unwatch(removed);
    bundleInputs = files;
  }

  let isDeploying = false;
  let deployQueued = false;
  let stopping = false;
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
    if (stopping) return;
    if (isDeploying) {
      deployQueued = true;
      return;
    }

    isDeploying = true;

    async function run() {
      try {
        // The child logs the execution ID itself.
        const executionId = randomUUID();
        // A fresh process per deploy: importing the rebuilt infra in this
        // long-lived process would leak a copy of the bundle every time.
        await deployInChild({
          deployment,
          executionId,
          logger,
        });
      } catch (err) {
        logger.error(err);
      }
      // The deploy wrote the inputs files of the bundles that it built.
      watchBundleInputs();
      isDeploying = false;
      if (stopping) {
        await close();
      } else if (deployQueued) {
        deployQueued = false;
        triggerDeploy();
      }
    }

    void run().catch(logger.error);
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
    await Promise.all([
      watcher.close(),
      configWatcher.close(),
      bundleWatcher.close(),
      closeCompile(),
    ]);
    exit(1);
  }

  await Promise.all([once(watcher, "ready"), once(configWatcher, "ready")]);
}
