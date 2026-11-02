# Project Config

Each project has a `notation.config.ts` at its root:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "my-app",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
```

| Field          | Required | Meaning                                                |
| -------------- | -------- | ------------------------------------------------------ |
| `app`          | Yes      | The name of the app.                                   |
| `entry`        | Yes      | The entry file, relative to the config.                |
| `defaultStage` | No       | The stage that a command uses when given no `--stage`. |

The CLI deploys the entry file and every module that it imports.

## Project root

The project root is the directory that holds the config. The entry file, `dist/` and `.notation/workflows.db` are relative to it.

The CLI finds the config by searching up from the current directory. The search stops at the first directory that holds a `notation.config.ts` or a `package.json`. So a config at the root of a monorepo never applies to a package inside it.

## Several entry points

A config has one entry. To deploy parts of a project separately, write one config for each part, and choose a config with `--config`:

```ts [jobs.config.ts]
export default defineConfig({
  app: "my-app-jobs",
  entry: "infra/jobs.ts",
  defaultStage: "dev",
});
```

```sh
notation deploy                          # uses notation.config.ts
notation deploy --config jobs.config.ts  # uses jobs.config.ts
```

**Each config needs its own `app`.** Two configs with the same app share state and AWS names.

## Stages

A stage is one deployed copy of the app, such as `dev` or `prod`:

```sh
notation deploy --stage prod
```

Without `--stage`, a command uses `defaultStage`. If neither is set, the command fails:

```sh
No stage given. Pass --stage, or set defaultStage in notation.config.ts
```

## State key

Notation keys the state of a deployment by `<app>:<stage>`:

| Command                                                | State key          |
| ------------------------------------------------------ | ------------------ |
| `notation deploy --stage dev`                          | `my-app:dev`       |
| `notation deploy --stage prod`                         | `my-app:prod`      |
| `notation deploy --config jobs.config.ts --stage prod` | `my-app-jobs:prod` |

The key contains no file paths, so you can move the entry file and keep its state.

## AWS names

Every stage creates the same resources. To keep the stages apart in one AWS account, Notation starts each AWS name with the app and the stage: `<app>--<stage>--<id>`.

For example, the starter app has a Lambda function with the ID `todos-getTodos`:

| Stage  | Lambda function                | IAM role                            |
| ------ | ------------------------------ | ----------------------------------- |
| `dev`  | `my-app--dev--todos-getTodos`  | `my-app--dev--todos-getTodos-role`  |
| `prod` | `my-app--prod--todos-getTodos` | `my-app--prod--todos-getTodos-role` |

The parts are joined with `--`, because app and stage names can't contain `--`. With a single `-`, app `my-app` with stage `prod-eu` and app `my-app-prod` with stage `eu` would get the same names.

| Resource               | AWS name                    | Longest name |
| ---------------------- | --------------------------- | ------------ |
| Lambda function        | `<app>--<stage>--<id>`      | 64           |
| IAM role of a function | `<app>--<stage>--<id>-role` | 64           |
| SQS queue              | `<app>--<stage>--<name>`    | 80           |
| EventBridge rule       | `<app>--<stage>--<name>`    | 64           |
| API Gateway API        | `<app>--<stage>--<name>`    | 128          |

Names that only need to be unique inside another resource have no prefix. For example, a role's inline policy is `<id>-role-policy`. A function's log group is `/aws/lambda/<function name>`, so it contains the app and the stage already.

**Long names are shortened.** If a name is longer than the service allows, Notation cuts it and adds `-` and an 8-character hash of the full name. For example, `my-app--prod--warehouse-processIncomingOrderNotificationsFromSuppliers` has 70 characters, and Lambda allows 64:

| Resource        | AWS name                                                           |
| --------------- | ------------------------------------------------------------------ |
| Lambda function | `my-app--prod--warehouse-processIncomingOrderNotificatio-9bed4260` |
| IAM role        | `my-app--prod--warehouse-processIncomingOrderNotificatio-cf8fdd43` |

The hash comes from the full name, so a shortened name is the same on every deploy. A FIFO queue's name keeps its `.fifo` ending.

## Name rules

The app and stage names must:

- have 1 to 32 characters,
- use only `a-z`, `0-9` and `-`,
- not start or end with `-`,
- not contain `--`.

| Name        | Valid | Reason                   |
| ----------- | ----- | ------------------------ |
| `my-app`    | Yes   |                          |
| `prod-eu-1` | Yes   |                          |
| `My_App`    | No    | Uppercase letter and `_` |
| `-preview`  | No    | Starts with `-`          |
| `my--app`   | No    | Contains `--`            |

`defineConfig` checks `app` and `defaultStage` at compile time:

```ts
defineConfig({ app: "My_App", entry: "infra/api.ts" });
// Type '"My_App"' is not assignable to type '"\"My_App\" is not name-safe"'.
```

Write the names as string literals. A value typed as `string` fails the check.

The CLI checks the names again when it loads the config, and it also checks `--stage`. It rejects unknown config fields, and fails if the entry file doesn't exist.
