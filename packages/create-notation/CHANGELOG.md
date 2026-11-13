# create-notation

## 0.3.0

### Minor Changes

- ce76cd5: The starter's runtime module declares its Lambda with `$lambda` and exports `handler`. The starter's infra routes `/todos` to `() => lambda`. The declaration has `event: () => apiGateway.schema(null)`, as its requests have no body.
- 121442b: The starter app has a `notation.config.ts`, and its scripts no longer pass an entry path. The config's `app` is the project directory name in lowercase, with each run of other characters replaced by `-`. The starter depends on `@notation/core`, because the config imports `defineConfig` from it.

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- ce76cd5: Runtime modules are found by their declaration, such as `$lambda`, in the files that `files.runtime` in `notation.config.ts` matches. The default is `runtime/**`. This replaces the fixed `runtime/**/*.fn.ts` glob, so a runtime module's file name doesn't need a `.fn` ending. The starter's runtime module is `runtime/todos.ts`.
- 3fefade: `@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

  `@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

  The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.

## 0.2.1

### Patch Changes

- 16a0209: Lambda functions now need an explicit, name-safe `id`. Notation no longer derives one from the handler name and a hash of the code's file path.

  - `lambda()` requires `id`. It must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. TypeScript rejects string literals that break the rule and values typed as plain `string`. At runtime, `lambda()` throws an error that names the bad ID.
  - The `config` export of a `.fn.ts` file requires `id`. Each handler gets the ID `<id>-<handler>`, which must also be name-safe. Compilation fails if `id` is missing or the resulting ID isn't name-safe.
  - Declaring two Lambda functions with the same ID in one deployment throws. IDs that differ only in case also clash, because IAM role names ignore case.
  - `@notation/aws/lambda` exports `NameSafe`, `isNameSafe` and `LAMBDA_ID_MAX_LENGTH`, and `@notation/resource` exports `getActiveResourceCollection`.

## 0.2.0

### Minor Changes

- Fix package versions

## 0.1.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

## 0.0.5

### Patch Changes

- Fix updating std.zip resource

## 0.0.3

### Patch Changes

- Add hashbang

## 0.0.2

### Patch Changes

- 10a8133: Migrate project scaffolding to create-notation

## 0.0.1

### Patch Changes

- Create package
