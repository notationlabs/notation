# Project Config Reference

`notation.config.ts` defines an application's name, infrastructure entry point, default deployment stage, and module classification globs. Every CLI command loads it to isolate state, build outputs, and generated cloud names across applications and stages.

## Config schema

Export the default configuration from `notation.config.ts` using `defineConfig` from `@notation/core/config` (also re-exported from `@notation/core`):

```ts [@notation/core/config]
export type ModuleKind = "infra" | "runtime" | "shared";

export type ModuleFiles = {
  [Kind in ModuleKind]?: string | string[];
};

export type NotationConfig = {
  app: string;
  entry: string;
  defaultStage?: string;
  files?: ModuleFiles;
};

export function defineConfig<
  const App extends string,
  const Stage extends string = never,
>(config: {
  app: NameSafe<App>;
  entry: string;
  defaultStage?: NameSafe<Stage>;
  files?: ModuleFiles;
}): NotationConfig;
```

`NotationConfig` accepts four configuration fields:

| Field | Description |
| :--- | :--- |
| `app` | Application identifier validated against `NameSafe<S>` rules |
| `entry` | Infrastructure entry file path relative to the config directory |
| `defaultStage` | Fallback stage when `--stage` and `--execution-id` are omitted |
| `files` | Module classification globs for `infra`, `runtime`, and `shared` |

`app` and `entry` are required; `defaultStage` and `files` are optional.

### Runtime validation

When loading `notation.config.ts`, `parseConfig(value, fileName)` enforces the same contract at runtime:

- **Object shape** – The default export must be a plain object, and any key outside `app`, `entry`, `defaultStage`, and `files` throws an error.
- **Required fields** – `app` must satisfy name-safety rules, and `entry` must be a non-empty string whose resolved path exists on disk for commands that evaluate infrastructure.
- **Optional fields** – If defined, `defaultStage` must satisfy name-safety rules and `files` must be an object containing only `infra`, `runtime`, or `shared` keys.

## Name safety

Both `app` and `defaultStage` in `notation.config.ts`, as well as `--stage` on the CLI, must satisfy Notation's config name-safety rules:

| Rule | Requirement |
| :--- | :--- |
| Characters | Lowercase ASCII letters, digits, and single hyphens |
| Length | `1` to `32` characters |
| Hyphens | Cannot start with `-`, end with `-`, or contain `--` |

Values must match `^[a-z0-9]+(?:-[a-z0-9]+)*$` within `maxNameLength = 32`. `defineConfig` checks `app` and `defaultStage` at compile time via `NameSafe<S>`, rejecting non-literal widened `string` types and invalid literals. `isNameSafe` and `assertNameSafe` enforce the same rules at runtime.

For resource and declaration `id` validation rules, see [Physical Names Reference](./physical-names.md).

## Module globs

By default, Notation classifies script files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`) under the config directory using `defaultModuleGlobs`:

| Kind | Default glob |
| :--- | :--- |
| `infra` | `["infra/**"]` |
| `runtime` | `["runtime/**"]` |
| `shared` | `["shared/**"]` |

Each key in `files` accepts a single glob string or an array of glob strings, and setting one key overrides only that kind while omitted keys keep their defaults:

```ts [notation.config.ts]
import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "orders-app",
  entry: "src/infra/main.ts",
  defaultStage: "dev",
  files: {
    infra: ["src/infra/**", "!src/infra/**/*.test.ts"],
    runtime: ["src/functions/**", "!src/functions/**/*.test.ts"],
    shared: [],
  },
});
```

Setting a kind to `[]` disables automatic classification for that kind. Providing an empty string or an array containing only `!` exclusion globs fails config validation.

### Pattern normalization

Before matching paths relative to the config directory using POSIX glob rules, Notation normalizes each glob pattern:

| Pattern | Normalization |
| :--- | :--- |
| Leading `!` | Marks an exclusion that prevents matching files from receiving the kind |
| Leading `./` | Stripped after checking for `!` |
| Trailing `/` | Expands `<dir>/` to `<dir>/**` |
| Plain path | Expands `path` to `[path, "${path}/**"]` when no glob syntax is present |

Glob characters treated as syntax are `*`, `?`, `[`, and `{`. For example, `"infra/"` expands to `"infra/**"`, and a plain file or directory path matches either that exact file or any file beneath it.

### Ignored paths

Certain paths never receive a module kind regardless of `files` globs:

| Category | Excluded paths |
| :--- | :--- |
| Ignored directories | `dist`, `node_modules`, and any dot-directory at any depth |
| Non-script files | Files whose extension does not match `/\.[cm]?[jt]sx?$/` |
| External files | Files outside the project root directory |
| Nested packages | Files inside a subdirectory whose `package.json` has a `name` field |

Dot-directories are directory names starting with `.`, such as `.notation` or `.git`.

### Overlap errors

Each script file can belong to at most one module kind. If a file matches more than one kind among `infra`, `runtime`, and `shared`, compilation fails and reports the file path, both matching kinds, and both glob patterns (noting when a conflict comes from a default glob).

## Config discovery

Without `--config`, Notation walks upward from `process.cwd()` looking for `notation.config.ts`:

```text [discovery order]
1. <dir>/notation.config.ts exists -> project root is <dir>
2. <dir>/package.json exists (without notation.config.ts) -> stops walk; reports missing config in <dir>
3. Filesystem root reached without either file -> falls back to process.cwd()
```

Stopping at a directory with `package.json` prevents a parent package's `notation.config.ts` from claiming a nested workspace package.

Passing `--config <path>` bypasses the upward walk and resolves the config file directly. The directory containing the active config file becomes the project root for `entry`, `files` globs, `dist/`, `.notation/workflows.db`, and config bundle caching (`node_modules/.cache/notation/`).

During `notation watch`, editing the active config file waits for any running deploy to finish and exits with code `1` so you can restart with the updated configuration.

## Stage resolution

Notation identifies each deployment by `<app>:<stage>` (for example `orders-app:prod`). Except for `notation compile`, which does not resolve a stage, CLI commands determine the active stage in strict precedence order:

1. **Resumed execution** – Passing `--execution-id <id>` uses the stage recorded on that execution and fails if `config.app` mismatches or if `--stage` passes a different stage.
2. **CLI flag** – Passing `--stage <stage>` overrides `defaultStage`.
3. **Config default** – If `--stage` is omitted, Notation uses `config.defaultStage`.
4. **Missing stage** – Commands fail if neither `--stage` nor `defaultStage` is provided.

### Reading active deployment

Infrastructure code can read the resolved `{ app, stage }` pair during evaluation via `deployment()` from `@notation/core`:

```ts [infra/orders.ts]
import { deployment } from "@notation/core";

const { app, stage } = deployment();
```

Calling `deployment()` outside infrastructure evaluation (for example inside a runtime handler or before evaluation starts) throws an error. See [Project Config](../core/project-config.md) for usage examples.
