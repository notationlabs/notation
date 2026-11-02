---
"@notation/core": minor
"@notation/cli": minor
"@notation/esbuild-plugins": minor
---

Each runtime module deploys as one resource.

- `runtimeModules` in `notation.config.ts` sets the globs for runtime modules: a glob or an array of globs, relative to the config. The default is `**/*.fn.ts`.
- A file is a runtime module only if it matches a glob and exports `resource`, e.g. `export const resource = { service: "aws/lambda", id: "todos", timeout: 5 }`. A matching file without `resource` is an ordinary module.
- `resource` replaces `config`. A matching file that exports `config` and no `resource` fails the build with a message to rename it.
- `resource` must be an object literal with a `service` and an `id`. Its values must be literals, because the compiler reads them without running the module.
- In the infra phase, the compiler replaces a runtime module with a generated module. The generated module declares the resource, and exports `{ resource, export: "<name>" }` for each export. None of the runtime module's code runs at deploy time.
- The runtime bundle exports one `handler`, which dispatches each event to an export of the module.
