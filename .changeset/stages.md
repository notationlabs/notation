---
"@notation/core": minor
"@notation/cli": minor
"@notation/aws": minor
"@notation/resource": minor
---

Deployments are identified by app, stage and entry name (RFC 0005), so one codebase can be deployed as several stages.

- Each project needs a `notation.config.ts` at its root, whose default export is `defineConfig({ app, entries, defaultStage? })` from `@notation/core/config`. That entry point loads only the config code, not the runtime. `entries` maps entry names to entry files.
- `app`, entry names and stage names must be name-safe: 1 to 32 characters from `a-z`, `0-9` and `-`, with no leading or trailing `-`. The `NameSafe` type checks `app`, entry names and `defaultStage` at compile time, and the CLI checks them again when it loads the config.
- Every CLI command takes an entry name instead of a path. `deploy`, `plan`, `destroy`, `watch` and `dashboard` take `--stage`, which falls back to `defaultStage` and is otherwise required: `notation deploy orders --stage prod`.
- State is keyed by `<app>:<stage>:<entry>`. State under the old path key is not migrated, so the first deploy after the upgrade treats an existing deployment as new.
- `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entry, entryPoint }` instead of `entryPoint`. `NodeDurableRuntime` takes `deployment: { app, stage, entry }` instead of `deploymentId`, and exposes both. `resolveDeploymentId` takes a deployment identity instead of a path.
- `loadProject()` finds the project root from the working directory, loads its `notation.config.ts` and returns `{ root, config }`. `resolveDeployment(project, { entry, stage })` and `resolveEntryPoint(project, entry)` resolve an entry against that root.
- The project root is the nearest directory with a `notation.config.ts`, searching up no further than the nearest `package.json`. The config, entries, `dist` and the state database all resolve against it.
- AWS names start with the app and the stage, so several apps and stages can share one AWS account. A Lambda function is named `<app>-<stage>-<id>` and its role `<app>-<stage>-<id>-role`. SQS queues, EventBridge rules and API Gateway APIs are named `<app>-<stage>-<name>`. A name longer than the service allows is cut short and ends in `-` and an 8-character hash of the full name, and a FIFO queue's name keeps its `.fifo` ending. Names given directly in the config of an `@notation/aws.iac` resource, such as `QueueName`, are used as they are.
- The names of existing resources change. The first deploy after the upgrade finds no state under the new key (see above), so it creates every resource under its new name, and the old resources stay in AWS without anything to manage them. Destroy the old deployment with the previous CLI before upgrading. A deployment that already has state under its new key replaces its Lambda functions, IAM roles, SQS queues (and their messages) and EventBridge rules on its next deploy, and renames its API Gateway APIs in place, so their IDs and URLs stay the same.
- `collectResourceGraph(evaluate, { scope })` takes the app and the stage, and `scopedPhysicalName` and `physicalName` in `@notation/resource` make the names. `getResourceGraph(entryPoint, scope?)` passes the scope, and `deployApp`, `planApp` and `destroyApp` pass the deployment's app and stage.
