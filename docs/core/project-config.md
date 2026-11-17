# Project Config

`notation.config.ts` defines your application's identity, infrastructure entry point, default stage, and module directories. Every CLI command reads it to isolate build outputs, local state, and cloud resource names across apps and environments.

Export a default configuration using `defineConfig` from `@notation/core/config`:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entry: "infra/orders.ts",
  defaultStage: "dev",
});
```

`defineConfig` configures your application identity, root infrastructure entry, fallback stage, and module folder overrides:

| Field | Purpose |
| :--- | :--- |
| `app` | Short lowercase identifier for your application |
| `entry` | Relative path to your root infrastructure module |
| `defaultStage` | Target stage used when `--stage` is omitted |
| `files` | Custom globs overriding `infra/`, `runtime/`, and `shared/` |

`app` and `entry` are required; `defaultStage` and `files` are optional. `defineConfig` is also re-exported from `@notation/core`.

## Naming constraints

Both `app` and stage names (`defaultStage` or `--stage`) use 1 to 32 lowercase ASCII letters, digits, or single hyphens (`a-z`, `0-9`, `-`), with no leading, trailing, or double hyphens (`--`). Because Notation generates physical cloud names in `<app>--<stage>--<base>-<instance>` format, forbidding `--` prevents naming collisions across apps and stages.

## Deployment stages

Notation identifies each isolated deployment by `<app>:<stage>`, such as `orders-app:prod`. Pass `--stage` to target another environment without editing `notation.config.ts`:

```sh [Terminal]
notation plan --stage prod
```

When `--stage` is omitted, Notation falls back to `defaultStage` (or fails if neither is set), while `--execution-id` always resumes the stage recorded on that execution.

### Reading the active stage

Infrastructure code can call `deployment()` from `@notation/core` to branch settings by environment during evaluation:

::code-group

```ts [infra/orders.ts (AWS)]
import { deployment } from "@notation/core";
import { queue } from "@notation/aws/sqs";
import { Order } from "../shared/schema";

const { stage } = deployment();

export const orderQueue = queue({
  id: "orders",
  schema: Order,
  messageRetentionPeriod: stage === "prod" ? 1_209_600 : 3_600,
});
```

```ts [infra/orders.ts (Cloudflare)]
import { deployment } from "@notation/core";
import { kv } from "@notation/cloudflare/resources";

const { app, stage } = deployment();

export const orderCache = new kv.KVNamespace("orders-cache", {
  config: { Title: `${app}-${stage}-orders-cache` },
});
```

::

Calling `deployment()` outside infrastructure evaluation throws an error.

## Custom layouts

By default, Notation looks for `infra/**`, `runtime/**`, and `shared/**` relative to `notation.config.ts`. Set `files` to map an existing `src/` layout or exclude test files:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entry: "src/infra/orders.ts",
  defaultStage: "dev",
  files: {
    infra: ["src/infra/**", "!src/infra/**/*.test.ts"],
    runtime: ["src/functions/**", "!src/functions/**/*.test.ts"],
    shared: "src/shared/**",
  },
});
```

Omitted keys keep their default globs, setting a key to `[]` disables that module kind, and overlapping globs fail the build so every file has at most one role.

## Multiple configs

In monorepos or multi-service directories, pass `--config` to target a specific config file from anywhere:

```sh [Terminal]
notation deploy --config apps/orders/jobs.config.ts --stage staging
```

Without `--config`, Notation walks upward from the working directory until it finds `notation.config.ts` or hits a `package.json`. The config file's directory becomes the project root for `entry`, `files`, `dist/`, and `.notation/workflows.db` (override state location with `NOTATION_DATABASE_PATH`).
