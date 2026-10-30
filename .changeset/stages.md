---
"@notation/core": minor
"@notation/cli": minor
---

Deployments are identified by app, stage and entry name (RFC 0005), so one codebase can be deployed as several stages.

- Each project needs a `notation.config.ts` at its root, whose default export is `defineConfig({ app, entries, defaultStage? })` from `@notation/core/config`. That entry point loads only the config code, not the runtime. `entries` maps entry names to entry files.
- `app`, entry names and stage names must be name-safe: 1 to 32 characters from `a-z`, `0-9` and `-`, with no leading or trailing `-`. The `NameSafe` type checks `app`, entry names and `defaultStage` at compile time, and the CLI checks them again when it loads the config.
- Every CLI command takes an entry name instead of a path. `deploy`, `plan`, `destroy`, `watch` and `dashboard` take `--stage`, which falls back to `defaultStage` and is otherwise required: `notation deploy orders --stage prod`.
- State is keyed by `<app>:<stage>:<entry>`. State under the old path key is not migrated, so the first deploy after the upgrade treats an existing deployment as new.
- `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entry, entryPoint }` instead of `entryPoint`. `NodeDurableRuntime` takes `deployment: { app, stage, entry }` instead of `deploymentId`, and exposes both. `resolveDeploymentId` takes a deployment identity instead of a path.
- `loadProject()` finds the project root from the working directory, loads its `notation.config.ts` and returns `{ root, config }`. `resolveDeployment(project, { entry, stage })` and `resolveEntryPoint(project, entry)` resolve an entry against that root.
- The project root is the nearest directory with a `notation.config.ts`, searching up no further than the nearest `package.json`. The config, entries, `dist` and the state database all resolve against it.
