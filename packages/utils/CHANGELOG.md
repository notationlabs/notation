# @notation/utils

## 0.26.0

## 0.25.0

## 0.24.1

### Patch Changes

- 99eb8e8: The `id` option of `kvJson()`, `queue()`, `jwtAuthorizer()`, `api()`, `eventBus()`, `rule()`, `schedule()`, `lambda()` and `$lambda` takes an id built from another id. `NameSafe` and `IdOption` still check a string literal such as `"flags"` in full. A template literal type such as `${string}-config` now passes when its fixed parts hold only letters, digits, hyphens and underscores, so `${string}.config` is still a type error. Plain `string` now passes. The holes of a template and a plain string are checked when the resource is declared, as before.

## 0.24.0

### Minor Changes

- 386a2a9: `kvJson()` in the new `@notation/cloudflare/kv` entry point declares a JSON document in a KV key, with a `schema` option. It returns a `KVJsonGroup` with `schema`, `value` and `contribute`. Any infra module can add object keys to the document with `contribute`, and the parts merge as a Lambda's `Environment` does. Plan and deploy check the merged document against the schema before they write it. Each contribution is typed as a `JsonPartial` of the schema's input.

  `cloudflare.kv.KVJsonValue` in `@notation/cloudflare/resources` is the resource that `kvJson()` declares. Its `Value` param is a JSON value, written with sorted keys. Its validator refuses a value that `JSON.stringify` would change, such as `NaN`, a `Date`, a sparse array or a nested `undefined`, an object key named `__proto__`, and a text of more than 25 MiB. A read of text that is not JSON, or JSON that the validator refuses, returns the text as a string, so plan shows an update rather than failing. Text too long to hold as a JSON string within 25 MiB reads as a short string that gives its length.

  `readKVJson(namespace, key, schema)` and `KVJsonError` in `@notation/cloudflare/workers` read a JSON document in a Worker. `readKVJson()` returns `undefined` for a missing key, and throws `KVJsonError` for text that is not JSON or a value that fails the schema.

  The `JsonValue` type of the KV API calls is replaced by `Json`, which `json()` bindings use. A pending write check of a `KVValue` now names the class in its message.

  `assertId`, `isNameSafe`, `ID_MAX_LENGTH`, `NameSafe` and `IdOption` move from `@notation/aws` to `@notation/utils`, and `@notation/aws` re-exports them. The error for a missing id no longer says that the id is the base of the AWS name.

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

### Minor Changes

- a9e3fe4: Secrets take their values from sources, part 2 of RFC 0017. Notation writes a secret's value to its store, and never records the value.

  - `secret({ id, source, key })` from `@notation/cloudflare/secrets-store` takes its value from a source. `@notation/std/sources` exports `env`, which reads `process.env`, and `dotenv(path)`, which reads a `.env` file relative to the project root. `source` and `key` are given together. Each secret with a source has a `SourceValue` resource, `value:<id>`, which records the secret's id, the source's name, the key and a version. `env` and `dotenv` have no versions, so their secrets are written on every deploy. A source's `version` may return `undefined` for one key, which is then written on every deploy too. Plan and deploy fail when the source doesn't have the key.
  - A secret without a source takes its value from a hidden prompt, when deploy creates it. With no terminal, or with `--json`, deploy fails with the command that sets the secret. `notation watch` asks at each deploy that needs the value. Plan never asks, and notes that deploy will. A secret without a source that already exists is recorded without asking.
  - `notation secret set <id>` writes a secret's value, read from a hidden prompt or from stdin. `notation secret delete <id>` deletes a secret, and needs `--yes` without a terminal. Both refuse an API token's secret.
  - `SecretsStoreSecret` now requires `ValueFrom`, and its create and update write the value.
  - `Redacted` from `@notation/core` holds a secret value. Turning it into a string or JSON throws, and `console.log` prints `Redacted(<hidden>)`. A source implements the `Source` interface from `@notation/std/sources`, and a resource reads a value with `getValue(id)`.
  - The reconciler removes every secret value that the process read from the errors of operations before it records them, and the CLI removes them from the error that it prints when a command fails.

## 0.19.0

## 0.18.0

## 0.17.0

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- 3fefade: `@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

  `@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

  The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.

## 0.16.0

### Minor Changes

- 19a9d2e: Collected params: several pieces of code can add to one param.

  - A schema item with `collect` makes its param collected. `collect` combines the config value and every contribution, sorted by content.
  - `resource.contribute(values)` adds to a collected param while infra is evaluated. Contributions close when evaluation ends.
  - `resource.contribute(({ deps }) => values, { deps })` adds values computed from the real outputs of `deps` at deploy. The resource depends on `deps`.
  - `mergeContributions` merges maps key by key. Two contributions that set one key to different values throw `ContributionConflictError`, which names the `file:line` of both `contribute` calls.

  Output values: config can hold a resource's output before the resource exists.

  - `resource.outputValue(key)` returns a token. The holder depends on the resource, and deploy replaces the token with the real output.
  - Turning a token into a string throws `OutputValueStringError`. Compute with outputs in `deriveParams` or a function contribution.

  Plan:

  - A value that waits on an undeployed output shows as unknown at its own path.
  - `deriveParams` and function contributions receive views of their deps. Reading the output of an undeployed dep throws `PendingOutput`, and plan marks the affected params unknown.
  - Plan and deploy fail when a resource depends on a resource that is not part of the deployment. Before, the graph ignored the edge.

  Other:

  - `resource.dependOn(other)` adds a dependency after construction.
  - `onEvaluationEnd(callback)` runs a callback after evaluation, before contributions close.
  - `@notation/utils` adds `sortedJson`, JSON with sorted keys.

## 0.15.0

## 0.14.0

## 0.13.0
