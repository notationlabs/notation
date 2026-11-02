---
"@notation/core": minor
"@notation/cli": minor
"@notation/aws": minor
"@notation/resource": minor
"@notation/esbuild-plugins": minor
---

Notation identifies a deployment by its app and its stage (RFC 0005). You can deploy one codebase to several stages.

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
- Without `--stage`, a command uses `defaultStage`. If neither is set, the command fails.
- `--config <path>` chooses a config file. Use one config for each entry point.
- `watch` exits when the config file changes.
- `--execution-id` reads the stage from the execution, so `notation deploy --execution-id <id>` resumes a deploy to any stage. The command prints this resume command with the execution ID.
- The state key is `<app>:<stage>`.
- AWS names are `<app>--<stage>--<id>`, such as `my-app--prod--todos-getTodos`. If a name is longer than AWS allows, Notation cuts it and ends it with an 8-character hash. Notation does not change a name that you set directly on an `@notation/aws.iac` resource, such as `QueueName`.
- Lambda IDs can have up to 64 characters, up from 59.

API changes:

- `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entryPoint }` in place of `entryPoint`.
- `NodeDurableRuntime` takes `deployment: { app, stage }` in place of `deploymentId`.
- `loadProject()` returns `{ config }`. `setConfigFile(path)` chooses the config file, `configPath()` returns it, and `projectRoot()` returns its directory.
- `resolveDeployment`, `resolveDeploymentIdentity` and `resolveEntryPoint` resolve a deployment from a loaded project. `resolveDeploymentId` returns its state key.
- `readExecutionDeployment(executionId)` returns the app and stage saved with an execution. `resolveDeployment(project, { execution })` takes the stage from it. `parseDeploymentId` reads a state key back into its app and stage.
- `collectResourceGraph(evaluate, { scope })` and `getResourceGraph(entryPoint, scope?)` take the app and stage. `physicalName` and `scopedPhysicalName` in `@notation/resource` build the AWS names.
