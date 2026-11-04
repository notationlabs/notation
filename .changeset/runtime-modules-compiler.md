---
"@notation/core": minor
"@notation/cli": minor
"@notation/esbuild-plugins": minor
---

Each runtime module deploys as one resource.

- `runtimeModules` in `notation.config.ts` sets the globs for runtime modules. It takes a glob or an array of globs, relative to the config. The default is `**/*.fn.ts`.
- A file is a runtime module only if it matches a glob and exports `resource`, e.g. `export const resource = { service: "aws/lambda", id: "todos", timeout: 5 }`. A matching file without `resource` is an ordinary module.
- `resource` replaces `config`. If a matching file exports the old `config` object (one with a `service` property) and no `resource`, the build fails with a message to rename it.
- The compiler reads `resource` without running the module. So `resource` must be an object literal with literal values. It needs a supported `service` (only `aws/lambda` so far) and an `id` of 1 to 64 letters, digits, hyphens or underscores. Other keys must belong to the service; for `aws/lambda` these are `runtime`, `timeout` and `memory`.
- A runtime module can use `export const`, `export function`, `export class`, `export enum`, `export { a, b }` and `export * as name from`, with identifier names. Any other export form fails with one message that quotes the export. Export names that start with `__notation` are reserved.
- In the infra pass, the compiler replaces a runtime module with a generated module. The generated module declares the resource, and exports `{ resource, export: "<name>" }` for each export. None of the runtime module's code runs at deploy time.
- The runtime bundle exports one `handler`, which dispatches each event to an export of the module.
- The runtime pass bundles the runtime modules that the infra pass replaced, and no others. All the bundles build in one esbuild build. In watch mode, the runtime builds restart when an infra rebuild changes that set of modules.
- `resolveBuild(project)` in `@notation/core` returns the entry point and the runtime module globs, and `Deployment` includes both. `compile()` and `visualise()` in `@notation/cli` take this `Build` in place of an entry path.
