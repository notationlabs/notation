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

| Field            | Required | Meaning                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app`            | Yes      | The name of the app.                                                                                                                                                                                                                                                                                                                       |
| `entry`          | Yes      | The entry file, relative to the config.                                                                                                                                                                                                                                                                                                    |
| `defaultStage`   | No       | The stage that a command uses when given no `--stage`.                                                                                                                                                                                                                                                                                     |
| `runtimeModules` | No       | A glob or an array of globs, relative to the config, for the files that can be runtime modules. The default is `runtime/**/*.ts`. See [Runtime modules that infra doesn't import](./file-conventions.md#runtime-modules-that-infra-doesnt-import).                                                                                         |
| `sharedModules`  | No       | A glob or an array of globs, relative to the config, for modules that must stay free of infra. The build fails if one of them, or a project module that it imports directly or through other modules, declares a function or imports a resource function. The default is none. See [Shared modules](./file-conventions.md#shared-modules). |

The CLI deploys the entry file, every module that it imports, and each runtime module in the `runtimeModules` globs.

## Project root

The project root is the directory that holds the config. The entry file, `dist/` and `.notation/workflows.db` are relative to it.

The CLI finds the config by searching up from the current directory. The search stops at the first directory that holds a `notation.config.ts` or a `package.json`. So in a monorepo, a config at the root never applies to a package that has its own `package.json`.

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

**Each config needs its own `app`.** If two configs use the same app, a deploy of one config to a stage uses the same state key and AWS names as a deploy of the other config to that stage. Each deploy then sees the other config's resources in state but not in its entry file, and deletes them as orphans.

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

Each stage has the same set of resources. To keep the stages apart in one AWS account, Notation starts each AWS name with the app and the stage: `<app>--<stage>--<id>`.

For example, the starter app has a Lambda function with the ID `todos`:

| Stage  | Lambda function       | IAM role                   |
| ------ | --------------------- | -------------------------- |
| `dev`  | `my-app--dev--todos`  | `my-app--dev--todos-role`  |
| `prod` | `my-app--prod--todos` | `my-app--prod--todos-role` |

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

Notation computes the hash from the full name, so a shortened name is the same on every deploy. A FIFO queue's name keeps its `.fifo` ending.

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

The type of `defineConfig` makes TypeScript check `app` and `defaultStage`:

```ts
defineConfig({ app: "My_App", entry: "infra/api.ts" });
// Type '"My_App"' is not assignable to type '"\"My_App\" is not name-safe"'.
```

Write the names as string literals. A value of type `string` fails the check with the message `a name must be a string literal`.

When the CLI loads the config, it checks the names again and checks the `--stage` value. The CLI also fails if the config has a field it doesn't know, or if the entry file doesn't exist.
