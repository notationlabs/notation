# Project Config

Every Notation project has a `notation.config.ts` at its root. The config names the app and its entry file, and the CLI uses the app, together with a stage, to identify each deployment.

## The config file

The starter app from the [Quick Start](./quickstart.md) has this config:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

| Field          | Required | Meaning                                                           |
| -------------- | -------- | ----------------------------------------------------------------- |
| `app`          | Yes      | The name of the app. Notation never reads it from `package.json`. |
| `entry`        | Yes      | The entry file, relative to the project root.                     |
| `defaultStage` | No       | The stage that a command uses when you pass no `--stage`.         |

The directory that holds the config is the project root. The CLI resolves the entry file, writes `dist` and keeps `.notation/workflows.db` relative to the project root, so you can run commands from any directory inside the project.

To find the project root, the CLI starts in the current directory and moves up one parent at a time:

1. If the directory holds `notation.config.ts`, it is the project root.
2. If the directory holds a `package.json` but no config, the search stops, and the command fails because the project has no config.
3. Otherwise the CLI moves to the parent directory.

The search never passes the nearest `package.json`, so a config in a parent package, such as the root of a monorepo, never applies to a package inside it. Put the config next to the `package.json` of the package that you deploy.

## The entry

The entry file is the infrastructure module that Notation compiles and deploys. In the config above, the entry is `infra/api.ts`. The entry file can import other infrastructure modules, and their resources deploy with it.

CLI commands take no entry argument, because the config names the entry:

```sh
notation deploy
```

To move or rename the entry file, change `entry`. The state key does not contain the path, so the deployment keeps its state.

## Several entry points

A config has one entry. To deploy two parts of a project separately, such as an API and a set of scheduled jobs, give each part its own config, and choose a config with `--config`:

```ts [jobs.config.ts]
export default defineConfig({
  app: "my-app-jobs",
  entry: "infra/schedule.ts",
  defaultStage: "dev",
});
```

```sh
notation deploy                          # uses notation.config.ts, app my-app
notation deploy --config jobs.config.ts  # uses jobs.config.ts, app my-app-jobs
```

With `--config`, the CLI does not search for a config. The project root is the directory that holds the given file, and the entry resolves against that directory.

**Each config needs its own `app`.** The app and the stage form the state key and the start of every AWS name, as the next sections show. Two configs with the same app and the same stage would read and write the same state, and would create resources with the same names.

## Stages

A stage is one deployed copy of the app, such as `dev`, `staging` or `prod`. You choose the stage with `--stage`:

```sh
notation deploy --stage staging
notation deploy --stage prod
```

These two commands deploy the same code twice, and each stage gets its own state. Without `--stage`, a command uses `defaultStage`. If the config has no `defaultStage`, the `deploy`, `plan`, `destroy`, `watch` and `dashboard` commands must pass `--stage`:

```sh
No stage given. Pass --stage, or set defaultStage in notation.config.ts
```

## AWS names

Each stage of an app declares the same resources, because infra code cannot read the stage. To keep the stages apart in one AWS account, Notation starts the AWS name of each resource that it names with the app and the stage: `<app>--<stage>--<id>`. The parts are joined with `--` because app and stage names cannot contain `--`. Two different apps or stages therefore never produce the same AWS name.

For example, the starter app declares a Lambda function with the ID `todos-getTodos`. Each stage gets its own function and IAM role:

| Stage  | Lambda function                | IAM role                            |
| ------ | ------------------------------ | ----------------------------------- |
| `dev`  | `my-app--dev--todos-getTodos`  | `my-app--dev--todos-getTodos-role`  |
| `prod` | `my-app--prod--todos-getTodos` | `my-app--prod--todos-getTodos-role` |

The names of two apps differ in the same way, so several apps and stages can share one AWS account.

Notation scopes these names:

| Resource               | AWS name                    | Longest name |
| ---------------------- | --------------------------- | ------------ |
| Lambda function        | `<app>--<stage>--<id>`      | 64           |
| IAM role of a function | `<app>--<stage>--<id>-role` | 64           |
| SQS queue              | `<app>--<stage>--<name>`    | 80           |
| EventBridge rule       | `<app>--<stage>--<name>`    | 64           |
| API Gateway API        | `<app>--<stage>--<name>`    | 128          |

Names that only have to be unique inside another resource stay as they are. For example, the inline policy of a role is `<id>-role-policy`, and a function's log group is `/aws/lambda/<function name>`, which already contains the app and the stage.

**A name longer than the service allows is shortened.** Notation cuts the name short and ends it with `-` and an 8-character hash of the full name. For example, the function `warehouse-processIncomingOrderNotificationsFromSuppliers` in the `prod` stage would be named `my-app--prod--warehouse-processIncomingOrderNotificationsFromSuppliers`, which is 70 characters. Lambda allows 64, so Notation names the function and its role:

| Resource        | AWS name                                                           |
| --------------- | ------------------------------------------------------------------ |
| Lambda function | `my-app--prod--warehouse-processIncomingOrderNotificatio-9bed4260` |
| IAM role        | `my-app--prod--warehouse-processIncomingOrderNotificatio-cf8fdd43` |

The two names start the same way but end in different hashes, because each hash comes from a different full name. The hash is the same on every deploy, so a shortened name does not change between deploys. A FIFO queue's name keeps its `.fifo` ending after the hash.

The resource IDs in state do not contain the app or the stage. Only the names in AWS do.

## Deployment identity

Notation identifies a deployment by its app and its stage. The two names form the key of the deployment's state, `<app>:<stage>`:

| Command                                                | State key          |
| ------------------------------------------------------ | ------------------ |
| `notation deploy --stage dev`                          | `my-app:dev`       |
| `notation deploy --stage prod`                         | `my-app:prod`      |
| `notation deploy --config jobs.config.ts --stage prod` | `my-app-jobs:prod` |

The state key is important because it decides which state a command reads and writes. Two commands with the same key update the same resources. Two commands with different keys keep separate state, and each one deploys its own copy of the resources. Neither name comes from the file layout, so moving files does not change the key.

All deployments of a project root keep their state in the same database, `.notation/workflows.db`, under their own keys. See [State](../internals/state.md).

## Name rules

The app and stages must be name-safe:

- 1 to 32 characters,
- only lowercase letters `a-z`, digits `0-9` and hyphens `-`,
- no hyphen at the start or the end,
- no two hyphens in a row. AWS names use `--` to separate the app and the stage.

| Name        | Valid | Reason                   |
| ----------- | ----- | ------------------------ |
| `my-app`    | Yes   |                          |
| `prod-eu-1` | Yes   |                          |
| `My_App`    | No    | Uppercase letter and `_` |
| `-preview`  | No    | Starts with a hyphen     |
| `my--app`   | No    | Two hyphens in a row     |

`defineConfig` checks the app and `defaultStage` at compile time, so your editor reports a bad name before you run a command:

```ts
defineConfig({ app: "My_App", entry: "infra/api.ts" });
// Type '"My_App"' is not assignable to type '"\"My_App\" is not name-safe"'.
```

Write each name as a string literal. A name typed as `string`, such as one read from a variable declared `const app: string`, fails the compile-time check.

The CLI checks the same names again when it loads the config, and it also checks the stage given with `--stage`.

The CLI also rejects a config with a field that is not in the table above, such as `stage` instead of `defaultStage`, and a command fails when the entry file does not exist.

## Upgrading from entry paths

Before this config existed, CLI commands took an entry path, and Notation keyed state by that path:

| Before                         | After                            |
| ------------------------------ | -------------------------------- |
| `notation deploy infra/api.ts` | `notation deploy --stage dev`    |
| State key `infra/api.ts`       | State key `my-app:dev`           |
| No config file                 | `notation.config.ts` is required |

**Notation does not migrate state from the old path key.** The first deploy after the upgrade finds no state under the new key, so it treats every resource as new and tries to create it again. The new deployment starts its [AWS names](#aws-names) with the app and the stage, so its creates do not clash with the old resources. The resources of the old deployment stay in AWS, and Notation no longer manages them. Destroy the old deployment with the previous version of the CLI before you upgrade, or delete its resources by hand afterwards.
