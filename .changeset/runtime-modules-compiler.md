---
"@notation/core": minor
"@notation/cli": minor
"@notation/esbuild-plugins": minor
---

Each runtime module deploys as one resource.

- `runtimeModules` in `notation.config.ts` sets the globs for runtime modules: a glob or an array of globs, relative to the config. The default is `**/*.fn.ts`.
- A file is a runtime module only if it matches a glob and exports `resource`, e.g. `export const resource = { service: "aws/lambda", id: "todos", timeout: 5 }`. A matching file without `resource` is an ordinary module.
- `resource` replaces `config`. A matching file that exports the old `config` object (with a `service` property) and no `resource` fails the build with a message to rename it.
- `resource` must be an object literal with a `service` and an `id`, and only the keys that the service has (for `aws/lambda`: `service`, `id`, `runtime`, `timeout`, `memory`). Its values must be literals, because the compiler reads them without running the module. `service` must be a supported service (`aws/lambda`), and `id` must be 1 to 64 letters, digits, hyphens or underscores.
- A runtime module can't use `export default`, `export =`, `export *`, `export namespace`, `export import`, string export names, or export names that start with `__notation`.
- In the infra phase, the compiler replaces a runtime module with a generated module. The generated module declares the resource, and exports `{ resource, export: "<name>" }` for each export. None of the runtime module's code runs at deploy time.
- The runtime bundle exports one `handler`, which dispatches each event to an export of the module.
- The runtime pass bundles exactly the runtime modules that the infra pass replaced, all at the same time. In watch mode, the runtime bundles restart when an infra rebuild changes that set.
