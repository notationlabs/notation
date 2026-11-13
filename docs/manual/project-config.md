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

| Field          | Required | Meaning                                                                                                  |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `app`          | Yes      | The name of the app.                                                                                     |
| `entry`        | Yes      | The entry file, relative to the config.                                                                  |
| `defaultStage` | No       | The stage that a command uses when given no `--stage`.                                                   |
| `files`        | No       | Globs that give each file its kind of module: `infra`, `runtime` or `shared`. See [Files](#files) below. |

The CLI deploys the entry file, every module that it imports, and each runtime module that `files.runtime` matches.

## Files

`files` sets which files are infra, runtime and shared modules. Each key takes a glob or an array of globs, relative to the config:

```ts [notation.config.ts]
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  files: {
    infra: ["infra/**"],
    runtime: ["runtime/**", "jobs/*.ts"],
    shared: ["shared/**"],
  },
});
```

| Key       | Default          | What the build does with a matching file                                                                                                                               |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra`   | `["infra/**"]`   | Leaves it out of each function's bundle, unless the function uses it, which fails the build.                                                                           |
| `runtime` | `["runtime/**"]` | Reads it for a declaration, such as `$lambda`, and deploys the function even if infra doesn't import it.                                                               |
| `shared`  | `["shared/**"]`  | Bundles it as written in both builds, and fails if it declares a function or imports infra or runtime code. A shared module that neither build includes isn't checked. |

See [Module kinds](./file-conventions.md#module-kinds) for each kind.

**Each key replaces only its own default.** With `files: { shared: ["lib/**"] }`, `lib/` holds the shared modules, `shared/` holds no modules of any kind, and `infra/` and `runtime/` keep their defaults. Set a key to `[]` to give no file that kind.

The globs follow these rules:

- A leading `./` is allowed: `./runtime/**` is the same as `runtime/**`.
- A glob that ends in `/` matches the files in that folder: `infra/` is the same as `infra/**`.
- A glob with no `*`, `?`, `[` or `{` matches that path and the files under it: `infra` matches a file named `infra` and the files in `infra/`. The folder doesn't need to exist when the build starts, so a folder created in watch mode is matched.
- Errors quote a glob as the config writes it.
- A glob that starts with `!` excludes files. For example, `infra: ["infra/**", "!infra/**/*.test.ts"]` makes the test files in `infra/` have no kind.
- The build reads only JS and TS files, so a glob such as `infra/**` matches the same modules as `infra/**/*.ts` when the folder holds only `.ts` files.
- No file in `dist/`, `node_modules/` or a dot-directory such as `.notation/` has a kind, and no file outside the project root has one.

**A file that two kinds match fails the build**, even if nothing imports it. The error names the file and both globs, and says which glob is a default:

```text
shared/format.ts matches both files.infra and files.shared (files.infra: "**/*.ts"; files.shared: "shared/**", the default). A file can have only one kind. Change the globs so that only one of them matches it. files.shared isn't set in the config, so it has its default globs. Set it to replace them, or set it to [] for no shared modules.
```

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

**Each config needs its own `app`.** If two configs use the same app, a deploy of one config to a stage uses the same state key and the same `<app>--<stage>--` prefix for AWS names as a deploy of the other config to that stage. Each deploy then sees the other config's resources in state but not in its entry file, and deletes them as orphans.

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

Each stage has the same set of resources. To keep the stages apart in one AWS account, each AWS name starts with the app and the stage, as `<app>--<stage>--`. The parts are joined with `--`, because app and stage names can't contain `--`. With a single `-`, app `my-app` with stage `prod-eu` and app `my-app-prod` with stage `eu` would get the same names.

Every resource that you declare has an `id`, such as `todos` or `orders`. The `id` keys the resource in state. Deploy generates the rest of the AWS name from the `id` when it first creates the resource. For example, `queue({ id: "orders" })` is named `my-app--prod--orders-1a2b3c4d`.

**You can't set an AWS name.** A declaration takes no `name` option, and the config of a resource can't hold the field that AWS calls the name, such as `FunctionName` or `QueueName`. Deploy always generates it. If a later version lets you set an exact name, it will add an option for it.

**State keys have a type prefix.** Notation keys each resource in state with a prefix for its type and the IDs that it belongs to, joined with `:`, such as `lambda:todos:role` or `sqs-mapping:orders:process-orders`. An ID can't contain `:`, so resources of different types with the same ID, or of IDs that contain hyphens, never get the same key.

### Generated names

Deploy generates the AWS name: `<app>--<stage>--<base>-<instance>`.

- The base is the resource's state key without its type prefix, in lower case, with each run of characters other than `a-z` and `0-9` turned into one `-`. The state key `lambda:todos:role` gives the base `todos-role`. A function and a queue with the same `id` get the same base, and their names differ in the instance.
- The instance is 8 random hex characters.

For example, the starter app has a Lambda function with the ID `todos`:

| Stage  | Lambda function                | IAM role                            |
| ------ | ------------------------------ | ----------------------------------- |
| `dev`  | `my-app--dev--todos-5e0c91b7`  | `my-app--dev--todos-role-a41f6d02`  |
| `prod` | `my-app--prod--todos-c27d3f48` | `my-app--prod--todos-role-09be6a15` |

Deploy generates these names:

| Resource               | Generated name                         | Longest name |
| ---------------------- | -------------------------------------- | ------------ |
| Lambda function        | `<app>--<stage>--<id>-<instance>`      | 64           |
| IAM role of a function | `<app>--<stage>--<id>-role-<instance>` | 64           |
| SQS queue              | `<app>--<stage>--<id>-<instance>`      | 80           |
| SQS FIFO queue         | `<app>--<stage>--<id>-<instance>.fifo` | 80           |
| EventBridge rule       | `<app>--<stage>--<id>-<instance>`      | 64           |
| EventBridge schedule   | `<app>--<stage>--<id>-<instance>`      | 64           |
| EventBridge event bus  | `<app>--<stage>--<id>-<instance>`      | 256          |
| API Gateway API        | `<app>--<stage>--<id>-<instance>`      | 128          |

**Deploy generates a name once, and keeps it in state.** Deploy writes the name to state before it asks AWS to create the resource, and every later deploy reads the name from state. The name changes only when deploy replaces the resource: the replacement gets a new name, with a new instance. `notation plan` shows a generated name as unknown until the resource exists.

The infra code can't know a generated name. To pass a name to a function, bind an output ref of the resource in `env`, such as `ordersBus.name`.

**A generated name that is too long is cut before the instance.** For example, the function with the ID `warehouse-processIncomingOrderNotificationsFromSuppliers` is named `my-app--prod--warehouse-processincomingordernotificatio-1a2b3c4d`, which has the 64 characters that Lambda allows. The instance stays whole, so two cut names still differ. A function's name keeps the whole `id` when the app, the stage and the `id` together have at most 51 characters. With a long app name and a long stage name, the cut removes most or all of the `id`, and can remove the end of the stage. For example, app `customer-billing-platform` with stage `preview-pull-request-1234` leaves room for one character of the `id`, so the function `todos` is named `customer-billing-platform--preview-pull-request-1234--t-<instance>`. Such names differ in little more than the instance, so the name doesn't say which function it is.

**A generated name is only in state.** If the state record of a resource with a generated name is lost, deploy can't find the resource again. The next deploy generates a new name and creates a second resource, and the first one stays in AWS. There is one exception: a deploy that stops while it creates the resource has already written the name to state, so the next deploy uses the same name and finds the resource.

### Names that deploy does not generate

Some names have no prefix, because they only need to be unique inside another resource. An authorizer is named after its `id`, or its `name`, inside its API. A role's inline policy is `<id>-role-policy`. A function's log group is `/aws/lambda/<function name>`, so it contains the app and the stage already.

A state record made by a version of Notation before generated names holds a name of the form `<app>--<stage>--<id>`. Deploy reads the name from state and keeps it. The resource gets a generated name when deploy next replaces it.

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
