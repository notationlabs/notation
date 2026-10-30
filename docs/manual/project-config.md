# Project Config

Every Notation project has a `notation.config.ts` at its root. The config names the app and its entries, and the CLI uses these names, together with a stage, to identify each deployment.

## The config file

The starter app from the [Quick Start](./quickstart.md) has this config:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "my-app",
  entries: {
    api: "infra/api.ts",
  },
  defaultStage: "dev",
});
```

| Field          | Required | Meaning                                                              |
| -------------- | -------- | -------------------------------------------------------------------- |
| `app`          | Yes      | The name of the app. Notation never reads it from `package.json`.    |
| `entries`      | Yes      | Maps each entry name to an entry file, relative to the project root. |
| `defaultStage` | No       | The stage that a command uses when you pass no `--stage`.            |

The directory that holds the config is the project root. The CLI resolves entries, writes `dist` and keeps `.notation/workflows.db` relative to the project root, so you can run commands from any directory inside the project.

To find the project root, the CLI starts in the current directory and moves up one parent at a time:

1. If the directory holds `notation.config.ts`, it is the project root.
2. If the directory holds a `package.json` but no config, the search stops, and the command fails because the project has no config.
3. Otherwise the CLI moves to the parent directory.

The search never passes the nearest `package.json`, so a config in a parent package, such as the root of a monorepo, never applies to a package inside it. Put the config next to the `package.json` of the package that you deploy.

## Entries

An entry is an infrastructure module that Notation compiles and deploys as one unit. In the config above, the entry `api` points to `infra/api.ts`.

CLI commands take the entry name, not the file path:

```sh
notation deploy api
```

A project can have several entries, and each entry deploys separately:

```ts [notation.config.ts]
export default defineConfig({
  app: "my-app",
  entries: {
    api: "infra/api.ts",
    jobs: "infra/schedule.ts", // ← deployed with `notation deploy jobs`
  },
});
```

To move or rename an entry file, change its path in `entries`. The entry name stays the same, so the deployment keeps its state.

## Stages

A stage is one deployed copy of an entry, such as `dev`, `staging` or `prod`. You choose the stage with `--stage`:

```sh
notation deploy api --stage staging
notation deploy api --stage prod
```

These two commands deploy the same code twice, and each stage gets its own state. Without `--stage`, a command uses `defaultStage`. If the config has no `defaultStage`, the `deploy`, `plan`, `destroy`, `watch` and `dashboard` commands must pass `--stage`:

```sh
No stage given. Pass --stage, or set defaultStage in notation.config.ts
```

Infra code cannot read the stage, so every stage of an entry declares the same resources with the same names. In the starter app, every stage declares a Lambda function named `todos-getTodos` and an IAM role named `todos-getTodos-role`.

**Deploy each stage to its own AWS account.** The stage does not change resource names, so the second stage in one account asks AWS to create a Lambda function and an IAM role that already exist, and the deploy fails. Choose the account with an AWS profile:

```sh
AWS_PROFILE=staging notation deploy api --stage staging
AWS_PROFILE=prod notation deploy api --stage prod
```

## Deployment identity

Notation identifies a deployment by its app, its stage and its entry name. The three names form the key of the deployment's state, `<app>:<stage>:<entry>`:

| Command                             | State key          |
| ----------------------------------- | ------------------ |
| `notation deploy api --stage dev`   | `my-app:dev:api`   |
| `notation deploy api --stage prod`  | `my-app:prod:api`  |
| `notation deploy jobs --stage prod` | `my-app:prod:jobs` |

The state key is important because it decides which state a command reads and writes. Two commands with the same key update the same resources. Two commands with different keys keep separate state, and each one deploys its own copy of the resources. None of the three names come from the file layout, so moving files does not change the key.

All stages keep their state in the same database, `.notation/workflows.db`, under their own keys. See [State](../internals/state.md).

## Name rules

The app, entry names and stages must be name-safe:

- 1 to 32 characters,
- only lowercase letters `a-z`, digits `0-9` and hyphens `-`,
- no hyphen at the start or the end.

| Name        | Valid | Reason                   |
| ----------- | ----- | ------------------------ |
| `my-app`    | Yes   |                          |
| `prod-eu-1` | Yes   |                          |
| `My_App`    | No    | Uppercase letter and `_` |
| `-preview`  | No    | Starts with a hyphen     |

`defineConfig` checks the app, the entry names and `defaultStage` at compile time, so your editor reports a bad name before you run a command:

```ts
defineConfig({ app: "My_App", entries: { api: "infra/api.ts" } });
// Type '"My_App"' is not assignable to type '"\"My_App\" is not name-safe"'.
```

Write each name as a string literal. A name typed as `string`, such as one read from a variable declared `const app: string`, fails the compile-time check.

The CLI checks the same names again when it loads the config, and it also checks the stage given with `--stage`.

The CLI also rejects a config with a field that is not in the table above, such as `stage` instead of `defaultStage`, and a command fails when the file of its entry does not exist.

## Upgrading from entry paths

Before this config existed, CLI commands took an entry path, and Notation keyed state by that path:

| Before                         | After                             |
| ------------------------------ | --------------------------------- |
| `notation deploy infra/api.ts` | `notation deploy api --stage dev` |
| State key `infra/api.ts`       | State key `my-app:dev:api`        |
| No config file                 | `notation.config.ts` is required  |

**Notation does not migrate state from the old path key.** The first deploy after the upgrade finds no state under the new key, so it treats every resource as new and tries to create it again. The resources of the old deployment stay in AWS, so AWS rejects the creates of resources with fixed names, such as Lambda functions and IAM roles. Notation no longer manages the old resources. Destroy the old deployment with the previous version of the CLI before you upgrade, or delete its resources by hand afterwards.
