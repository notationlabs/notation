# Watch Runner

`notation watch` pairs incremental Rolldown compilation with Chokidar file watchers and single-flight child-process deploys so long-lived watch sessions never leak stale module graphs or overlap deployments.

## Two-Phase Compilation

`compile(build, opts)` (`packages/cli/src/compile.ts`) builds a project's infrastructure entry and runtime modules sequentially using a shared `ModuleAnalyses` instance (`{ files }`).

`compileInfra` bundles `infraEntry` (`platform: "node"`, `tsconfig: true`, `sourcemap: true`) to ESM `.mjs` files under `filePaths.dist.dir()` using `infraEntryPlugin` and `infraPlugin`. In watch mode, it starts `rolldownWatch` with `watch: { exclude: infraWatchExclude }` (`ignoredGlobs` from `@notation/build`) so writing to `dist/` never re-triggers builds, resolving only after the first `BUNDLE_END` event.

`compileRuntimeModules` filters `modules.filter((m) => m.entry)` and builds each declaration module into `dist/<module path>/index.mjs` using `functionBuildOptions(module.platform)` and `runtimePlugin`. In watch mode, it resolves once Rolldown emits `END`.

## Declaration Watcher Diffing

Every successful infra build invokes `onDeclarationModules(found)` with the sorted [`DeclarationModule[]`](./module-analysis.md) list from `infraPlugin`. In watch mode, `compile` serializes watcher updates through a promise chain (`updating = updating.then(...)`) so overlapping rebuilds never race:

```ts [packages/cli/src/compile.ts]
if (modules && sameModules(found, modules)) return;
if (!modules) logger.info("Watching runtime modules");
await disposeRuntime();
disposeRuntime = async () => {};
disposeRuntime = await compileRuntimeModules(found, {
  analyses,
  watch: true,
  onError: (error) => logger.error(error),
});
modules = found;
```

`sameModules` compares `JSON.stringify(a) === JSON.stringify(b)`. When an infra rebuild leaves declaration modules unchanged, `compile` keeps existing Rolldown runtime watchers running instead of restarting them.

`modules` updates only after `compileRuntimeModules` resolves. A failed runtime watcher startup therefore retries on the next infra rebuild.

## File Watchers

`watch(deployment, opts)` (`packages/cli/src/watch.ts`) starts `compile(deployment, { watch: true, logger })` and attaches three Chokidar watchers before awaiting `"ready"` on `watcher` and `configWatcher`:

| Watcher | Target |
| :--- | :--- |
| `watcher` | `filePaths.dist.dir()` for compiled infra and runtime bundle changes |
| `bundleWatcher` | [Bundle input manifests](./bundle-cache.md) from `bundleInputFiles()` excluding `node_modules` |
| `configWatcher` | `configPath()` for edits to `notation.config.ts` |

`watcher` uses `ignored: /(^|[\/\\])\../` and `persistent: true`. `bundleWatcher` starts empty with `ignoreInitial: true` and syncs via `watchBundleInputs()`, filtering out `node_modules` (`!/[\/\\]node_modules[\/\\]/`) so linked workspace packages stay watched and each deploy adds new inputs and unwatches removed ones. `configWatcher` uses `ignoreInitial: true` and honors `--config` when set.

## Deploy Coalescing

Both `watcher` and `bundleWatcher` invoke `debounceDeploy()`, which resets a `500` ms timer (`debounceTime = 500`) on each event before calling `triggerDeploy()`.

`triggerDeploy()` guarantees at most one deploy runs at a time using two flags (`isDeploying` and `deployQueued`):

- **Active deploy** – If `isDeploying` is true when the debounce timer fires, `triggerDeploy()` sets `deployQueued = true` and returns.
- **Shutdown priority** – If `stopping` is true, `triggerDeploy()` returns without starting a deploy.
- **Post-deploy drain** – When a deploy ends, `watchBundleInputs()` refreshes watched inputs and `isDeploying` clears. If `stopping` became true mid-deploy, `watch` calls `close()`; otherwise if `deployQueued` is true, it resets `deployQueued` and starts one follow-up deploy.

## Child Process Isolation

`deployInChild` (`packages/cli/src/deploy-child.ts`) executes each deploy in a fresh Node child process (`process.execPath`). Importing rebuilt ESM bundles inside the long-lived `watch` process would leak every bundle revision in V8's module cache.

Each run generates a fresh `randomUUID()` `executionId` and spawns the CLI entrypoint with fixed flags:

```ts [packages/cli/src/deploy-child.ts]
const args = [
  ...process.execArgv,
  process.argv[1]!,
  "deploy",
  "--config",
  configPath(),
  "--stage",
  deployment.stage,
  "--json",
  "--no-compile",
  "--no-drift-detection",
  "--execution-id",
  executionId,
];
```

`spawn` configures `stdio: ["ignore", "pipe", "inherit"]`:

| Stream | Mode |
| :--- | :--- |
| `stdin` | `"ignore"` so the child never reads standard input or blocks on prompts |
| `stdout` | `"pipe"` to stream NDJSON events line by line |
| `stderr` | `"inherit"` to pass child logs and errors straight to the parent |

`stdout` reads `EVENT_STREAM_VERSION = 1` NDJSON lines through `readline.createInterface`, strips `version`, and formats events with `createPrettyRenderer(logger)`, falling back to `logger.info(line)` for non-JSON lines.

## Signal Forwarding

`deployInChild` registers `SIGINT` and `SIGTERM` (`forwardedSignals`) listeners on the parent while a child deploy runs. If a signal arrives, `onSignal` detaches listeners (`stopForwarding()`), calls `child.kill(signal)`, and re-raises `proc.kill(proc.pid, signal)` so the parent exits with standard signal semantics. Normal child `"close"` and `"error"` events also call `stopForwarding()`.

## Config Change Exit

When `configWatcher` detects any change to `notation.config.ts`, `stop()` sets `stopping = true`, cancels any pending debounce timer, and logs that watch must restart to load the new config. If idle, `close()` runs immediately; if a deploy is in flight, `watch` waits for `deployInChild` to finish first.

`close()` shuts down all three Chokidar watchers and `closeCompile()` in parallel, then terminates with `exit(1)` (`process.exit(1)` by default) so external supervisors or developers restart cleanly.
