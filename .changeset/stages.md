---
"@notation/core": minor
"@notation/cli": minor
"@notation/aws": minor
"@notation/resource": minor
"@notation/esbuild-plugins": minor
---

Deployments are identified by app and stage (RFC 0005), so one codebase can be deployed to several stages.

A project needs a `notation.config.ts`:

```ts
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

- The app and stage names have 1 to 32 characters from `a-z`, `0-9` and `-`. They can't start or end with `-`, or contain `--`.
- CLI commands take no entry path: `notation deploy --stage prod`.
- `--stage` defaults to `defaultStage`. A command fails if neither is set.
- `--config <path>` chooses a config file. Use one config for each entry point.
- `watch` exits when the config file changes.
- State is keyed by `<app>:<stage>`.
- AWS names are `<app>--<stage>--<id>`, such as `my-app--prod--todos-getTodos`. A name that is too long is cut, and ends in an 8-character hash. Names set directly on an `@notation/aws.iac` resource, such as `QueueName`, are used as they are.
- Lambda IDs can have up to 64 characters, up from 59.

API changes:

- `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entryPoint }` in place of `entryPoint`.
- `NodeDurableRuntime` takes `deployment: { app, stage }` in place of `deploymentId`.
- `loadProject()` returns `{ config }`. `setConfigFile(path)` chooses the config file, `configPath()` returns it, and `projectRoot()` returns its directory.
- `resolveDeployment`, `resolveDeploymentIdentity` and `resolveEntryPoint` resolve a deployment from a loaded project. `resolveDeploymentId` returns its state key.
- `collectResourceGraph(evaluate, { scope })` and `getResourceGraph(entryPoint, scope?)` take the app and stage. `physicalName` and `scopedPhysicalName` in `@notation/resource` build the AWS names.
