# @notation/build

## 0.19.0

### Patch Changes

- Updated dependencies [19036ae]
  - @notation/core@0.19.0

## 0.18.0

### Patch Changes

- @notation/core@0.18.0

## 0.17.0

### Minor Changes

- ce76cd5: The compiler is built on Rolldown, in place of esbuild (RFC 0015). `@notation/esbuild-plugins` is replaced by `@notation/build`.

  - The builds find declaration functions by JSDoc marks in the packages that export them. `@declaration` marks a function that declares a function resource, such as `$lambda`, with the options that each build keeps. `@resource` marks a resource function, such as `queue`. `@resource runtime: schema` lists the options of the resource that a function reads. `@resource runtime:` with no options means the resource becomes `{}` in the function. The builds follow imports, re-exports and `export *` to the module that has the mark.
  - A declaration is written `const name = $lambda({ ... })` at the top level of its module, with an object literal that has no spread or computed keys. Any other call fails the build with its location, and so does a module with more than one declaration. A function that the user marks `@declaration` can call a declaration function inside it.
  - The infra build runs a stripped copy of each declaration module that the infra entry reaches. The copy keeps the declaration and the top-level statements that it uses. The handler, SDK clients, top-level `await`, logging and side-effect imports are removed. The declaration is wrapped in `__notation_declaredIn(...)`, which records the module's path, relative to the project root, and the name of its binding. The build fails if the module doesn't export `handler`, or if another module imports a name that the copy doesn't keep.
  - The runtime build bundles each declaration module to `dist/<module path>/index.mjs`, from a generated entry that re-exports `handler`. The declaration keeps only the options that the function uses: `id`, `event`, and the names of `env` without their values. An import whose uses the strip removed is removed too, so the bundle doesn't load the module it imports from, with or without `verbatimModuleSyntax`. Infra modules are marked free of side effects, so the bundler drops them when another module imports them. The build fails if a kept option refers to an infra module, or if an infra module or an infra function from a package, such as `queue()`, is still in the bundle. The error names the import chain from the function's module, and each use.
  - A resource from an infra module that a kept option names, such as `ordersQueue` in `sqs.bind(ordersQueue)`, becomes an object of the resource's runtime options in the runtime build: `sqs.bind({ schema: Order })`. Each option is imported from where infra imports it, which must be a shared module, a package, or a file that no glob matches and that calls no resource function at its top level. Each option must be a name that infra imports by name or as a default import, and not a member such as `schemas.Order` or an expression such as `Order.extend({ ... })`. The build fails if the resource is not a call to a resource function with an object literal, if the literal has a spread in place of a runtime option, written as a top-level const or in an object literal. The build can't tell a resource that a helper makes from a plain value, such as a schema, so the error says to declare a resource with a call to its resource function, and to move a plain value to a shared module. A resource marked with a bare `@resource` is not replaced, and gets the error for an infra value.
  - The strip follows `export default queue({ ... })` to the resource, and stops at an `export *` that leads back to a module it has visited. A resource that a `let` holds fails the build with the error for an infra value. A const of the function's module that holds a resource, such as `const local = ordersQueue`, fails the build with an error that says to pass the resource directly. A name that a local binding shadows, such as `q` in `(q) => sqs.bind(q)`, is left as it is. Added imports go after a hashbang line.
  - Packages stay external in the infra bundle, as before. Imports through tsconfig `paths` are bundled.
  - `compileInfra()` returns the declaration modules, as `{ path, binding, entry }`.

- d93d65a: Deploy now includes runtime modules that infra doesn't import. The infra build reads each file that `files.runtime` in `notation.config.ts` matches. The infra bundle imports the entry first, and then each of these files that calls a declaration function, such as `$lambda`. A file without a declaration is not imported.

  - In watch mode, the base directory of each `files.runtime` glob is watched, or its nearest existing parent, so a new runtime file is deployed without a restart.
  - The scan and the infra watcher skip `dist/`, `node_modules/` and dot-directories at any depth.
  - A file in the globs that can't be parsed fails the build, and the error names the file.

- 9d669fc: Each module's kind comes from globs in `files` in `notation.config.ts`. The kinds are `infra`, `runtime` and `shared`. The defaults are `infra/**`, `runtime/**` and `shared/**`, and each key replaces only its own default. A `!` glob excludes files from a kind. A glob that ends in `/` matches the files in that folder. A glob with no `*`, `?`, `[` or `{`, such as `"infra"`, matches that path and the files under it.

  ```ts
  export default defineConfig({
    app: "todos",
    entry: "infra/index.ts",
    files: { runtime: ["runtime/**", "jobs/*.ts"], shared: ["lib/**"] },
  });
  ```

  - **An infra module never runs in a function.** The runtime build leaves out every file that `files.infra` matches, even one that calls no resource function. A function that uses any value from such a file fails the build, even a plain constant. The error says to move the value to a shared module. Code that the function needs belongs in a shared module, or in a file that no glob matches.
  - **A setup module under `infra/` doesn't run in the function.** For example, `infra/setup.ts` sets a global, and a runtime module imports it with `import "../infra/setup"`. The runtime build leaves `infra/setup.ts` out, even though it calls no resource function, and the build doesn't fail. Move code that the function needs to a shared module, or to a file that no glob matches.
  - **Projects with infra outside `infra/` need `files.infra`.** Only `files.infra` makes a project file infra. A file that it doesn't match keeps its top-level code in the function, so if the file calls a resource function at its top level, such as `export const dlq = queue(...)` in `src/queues.ts`, a function that imports it fails the build. The error names the file and says to add it to `files.infra`, or, if the file holds a declaration, to move the call to an infra module. A kept option of a declaration that refers to a value from such a file, such as `event: () => sqs.bind(dlq)`, fails the build at the option's line. That error says to move a plain value that the option uses to a shared module, or to a file that no glob matches.
  - **A package file is infra only if `files.infra` matches it.** Package files are files outside the root, which include workspace packages, and files in folders below the root with a named `package.json`. `files.infra` can match only files below the root, so a workspace package outside the root is never infra. If the function imports a package file that calls a resource function at its top level, the bundle keeps the file and the build fails, unless the nearest `package.json` sets `"sideEffects": false` and the function uses no value from the file. For a file outside `node_modules`, the error says to set `"sideEffects": false` if the function uses no value from the file. If it does, the error says to read infra values through the declaration's `env()`, and to move a plain value that the function needs to a file that doesn't call a resource function. A file in `node_modules` gets no advice. A kept option that refers to a value from such a file fails at the option's line.
  - A shared module that either build includes fails the build if it declares a function, imports a resource function, or imports an infra or runtime module, directly or through modules that aren't infra or runtime. An import counts if the module uses it as a value, including as a JSX tag such as `<Comp />`. The error names the chain of imports with the position of each import. Projects with a `shared/` folder are checked by default.
  - A file that two kinds match fails the build, even if nothing imports it. The error names the file and both globs, and says which glob is a default. For example, `files: { infra: ["**/*.ts"] }` conflicts with the default `files.runtime`.
  - A declaration, such as `$lambda`, in an infra or shared module fails the build. A declaration in a file that no glob matches still works when infra imports it.
  - Errors that name an infra module say why it is infra, such as `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`. Errors quote a glob as the config writes it.
  - `@notation/core` adds `NotationConfig.files`, `Build.files`, `ModuleFiles`, `ModuleGlobs`, `ModuleKind`, `moduleKinds`, `defaultModuleGlobs` and `resolveModuleGlobs()`.

- 121442b: Notation identifies a deployment by its app and its stage (RFC 0005). You can deploy one codebase to several stages.

  A project needs a `notation.config.ts`:

  ```ts
  import { defineConfig } from "@notation/core/config";

  export default defineConfig({
    app: "my-app",
    entry: "infra/api.ts",
    defaultStage: "dev",
  });
  ```

  - The app and stage names have 1 to 32 characters from `a-z`, `0-9` and `-`. They can't start or end with `-`, or contain `--`.
  - CLI commands take no entry path: `notation deploy --stage prod`.
  - Without `--stage`, a command uses `defaultStage`. If neither is set, the command fails.
  - `--config <path>` chooses a config file. Use one config for each entry point.
  - `watch` exits when the config file changes.
  - `--execution-id` reads the stage from the execution, so `notation deploy --execution-id <id>` resumes a deploy to any stage. The command prints this resume command with the execution ID.
  - The state key is `<app>:<stage>`.
  - AWS names are `<app>--<stage>--<id>`, such as `my-app--prod--todos-getTodos`. If a name is longer than AWS allows, Notation cuts it and ends it with an 8-character hash. Notation does not change a name that you set directly on an `@notation/aws/resources` resource, such as `QueueName`.
  - Lambda IDs can have up to 64 characters, up from 59.

  API changes:

  - `deployApp`, `planApp` and `destroyApp` take `deployment: { app, stage, entryPoint }` in place of `entryPoint`.
  - `NodeDurableRuntime` takes `deployment: { app, stage }` in place of `deploymentId`.
  - `loadProject()` returns `{ config }`. `setConfigFile(path)` chooses the config file, `configPath()` returns it, and `projectRoot()` returns its directory.
  - `resolveDeployment`, `resolveDeploymentIdentity` and `resolveEntryPoint` resolve a deployment from a loaded project. `resolveDeploymentId` returns its state key.
  - `readExecutionDeployment(executionId)` returns the app and stage saved with an execution. `resolveDeployment(project, { execution })` takes the stage from it. `parseDeploymentId` reads a state key back into its app and stage.
  - `collectResourceGraph(evaluate, { scope })` and `getResourceGraph(entryPoint, scope?)` take the app and stage. `physicalName` and `scopedPhysicalName` in `@notation/resource` build the AWS names.

- f490162: The compiler can build Cloudflare Workers and Durable Object namespaces, for a provider package to declare with `$worker` and `$durableObject`.

  - A `@declaration` mark without `entry:` gets no runtime bundle. `compileInfra()` returns such a module with no `entry`. Before, the entry defaulted to `handler`, so a project's own wrapper marked `@declaration` without `entry:` now gets no bundle, and no error. Add `entry: handler` to the mark. An empty `entry:` clause fails the build.
  - The infra strip doesn't follow the names in `runtime:` options. A Durable Object class that `class: Counter` names, and its imports such as `cloudflare:workers`, are left out of the infra build.
  - A `runtime:` option whose value is a name that the module declares or imports, such as `class: Counter`, becomes a function with that name in the infra build, so the declaration can read `config.class.name`. The name is the local name at the call site. Any other value, including a class expression, a method and a global such as `undefined`, becomes a function whose name is `""`. A method option, such as `class() {}`, no longer gives invalid code.
  - The infra build strips each runtime module that has no declaration, as it strips declaration modules. The copy keeps the exports that code that runs at deploy uses, and the statements that they need, across modules. Its other top-level code, including side effects, doesn't run at deploy. Before, such a module ran whole at deploy.
  - A `cloudflare:` import, such as `cloudflare:workers`, that kept code doesn't use is removed. Code that runs at deploy and uses a name from a `cloudflare:` module fails the build, with the file, the name and the module that imports it, such as a declaration with `label: Counter.name`. Before, the build warned, and the infra bundle failed when deploy imported it. A static `cloudflare:` import that is still in the infra bundle, such as `export * from "cloudflare:workers"` in an infra module, fails the build and names the importing file. A dynamic `import()` of a `cloudflare:` module builds without a warning.
  - `infraPlugin()` takes `entryPoint`, the infra entry, which the strip of runtime modules starts from.
  - The mark clause `platform: workerd` builds the runtime bundle for workerd: Rolldown's `neutral` platform, wrangler's conditions and `NODE_ENV` defines, and `cloudflare:` and `node:` imports left external. A bare Node built-in, such as `events`, is imported as its `node:` module, even when an installed package, such as a polyfill, has the same name. A `require()` of a built-in, as in a CommonJS package, gets a module that imports the `node:` module, as wrangler does. The bundle re-exports the module's other value exports besides the entry, such as Durable Object classes, and not the declaration or types. `compileInfra()` returns the module with `platform`.
  - workerd doesn't start a Worker whose module exports a primitive, `null`, `undefined` or a module namespace object. The build fails, with the file and line, for an exported `const` with a primitive initialiser, and for `export * as ns from`, in a `platform: workerd` module.
  - For a `platform: workerd` declaration, the `declaredIn` record also holds `exports` and `starExports`, so the provider can check at plan time that the Worker exports each bound class under its name. `declaredIn()` takes them as a fourth argument, `moduleExports`.
  - The runtime build marks each declaration call `/*#__PURE__*/`, so the bundler drops a declaration that the bundle doesn't use. The runtime half of a declaration function must have no side effects.
  - In watch mode, a runtime bundle reads its module from disk when it builds, so a module that removes an export no longer logs a false build error before the infra rebuild restarts the runtime watcher. A module that loses its declaration, its entry or its entry export writes no bundle, and the last bundle stays.
  - `createRuntimeEntry` is no longer exported from `@notation/build`.
  - `@notation/build` exports `platformOf(name)`, which returns a platform's definition, the type `Platform` of that definition, and `PlatformName`, which is `"node" | "workerd"`. A definition holds a function that returns the runtime bundle's Rolldown options, whether the runtime entry re-exports the module's other exports, and the platform's check of export values. `ModuleAnalyses.fromDisk(file)` analyses a module from its current source on disk.
  - `DeclarationModule` is a union of its valid cases: no entry, an entry on Node, or an entry with `platform` and `exports`. The type of the `declaredIn` record, `DeclaredIn`, has both `exports` and `starExports` or neither. The record's runtime shape is the same.

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- 02c1fe4: The runtime build's bundle check now says that the function uses an infra module, or a resource function such as `queue()`, and names the file and line of each use. It used to say that the function's bundle includes it. The check reads the code before Rolldown's minify pass, so an unused call to an infra helper or to `queue()` fails the build even though the minify pass removes the call from the final bundle. The old wording was false in that case. The same builds pass and fail as before.

  The error for a resource function now lists only the uses of that function. It used to list the uses of every resource function in the bundle.

  For example:

  ```
  The function in runtime/orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orderQueue at runtime/orders.ts:15:31. It imports infra/orders.ts through runtime/orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).
  ```

- 46890c7: The build errors for a value that only exists at deploy now state the rule: the function can't use it, and why. They used to describe how the compiler builds the function. The same builds pass and fail as before.

  Each error says what can't be used, where, and why, and then what to move. For example, a function that reads a queue from a file with no kind:

  ```
  runtime/orders.ts:11:27: dlq can't be used in the `event` option of $lambda(), which the function uses, because it comes from lib/queues.ts, and loading lib/queues.ts calls queue(), which only runs at deploy. Read infra values in the function through the declaration's env(). Move a plain value that the option needs to a shared module (files.shared), or to a file that no glob matches and that doesn't call a resource function.
  ```

  It used to say:

  ```
  runtime/orders.ts:11:27: an option of $lambda that the function keeps refers to dlq, from lib/queues.ts. lib/queues.ts calls queue at its top level, so the function can't load it. The runtime build removes infra. Read infra values in the function through the declaration's env(). Move a plain value that a kept option uses to a shared module (files.shared), or to a file that no glob matches.
  ```

  The errors for a shared module and for a declaration in an infra or shared module have the same form. The error for an import of a runtime module's value at deploy no longer starts with `Illegal import:`.

- Updated dependencies [ae3d823]
- Updated dependencies [ce76cd5]
- Updated dependencies [d93d65a]
- Updated dependencies [9d669fc]
- Updated dependencies [35206ce]
- Updated dependencies [e4f4157]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [ce76cd5]
- Updated dependencies [3fefade]
- Updated dependencies [121442b]
- Updated dependencies [6cec012]
  - @notation/core@0.17.0

This package was `@notation/esbuild-plugins` until 0.16.0.

## 0.16.0

### Patch Changes

- Updated dependencies [19a9d2e]
- Updated dependencies [7d01d51]
  - @notation/core@0.16.0

## 0.15.0

### Minor Changes

- 16a0209: Lambda functions now need an explicit, name-safe `id`. Notation no longer derives one from the handler name and a hash of the code's file path.

  - `lambda()` requires `id`. It must be name-safe: 1 to 59 letters (`A-Z`, `a-z`), digits, hyphens or underscores. These are the characters AWS allows in Lambda function names, and 59 leaves room for the `-role` suffix in the 64-character IAM role name. TypeScript rejects string literals that break the rule and values typed as plain `string`. At runtime, `lambda()` throws an error that names the bad ID.
  - The `config` export of a `.fn.ts` file requires `id`. Each handler gets the ID `<id>-<handler>`, which must also be name-safe. Compilation fails if `id` is missing or the resulting ID isn't name-safe.
  - Declaring two Lambda functions with the same ID in one deployment throws. IDs that differ only in case also clash, because IAM role names ignore case.
  - `@notation/aws/lambda` exports `NameSafe`, `isNameSafe` and `LAMBDA_ID_MAX_LENGTH`, and `@notation/resource` exports `getActiveResourceCollection`.

- 4fe4451: Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

  This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.

### Patch Changes

- Updated dependencies [425f8ba]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [7a90e6b]
- Updated dependencies [6943418]
  - @notation/core@0.15.0

## 0.14.0

### Patch Changes

- @notation/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1

## 0.11.0

### Patch Changes

- @notation/core@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1

## 0.6.0

### Minor Changes

- Support externally managed lambda modules

## 0.5.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Updated dependencies [2a6fc59]
  - @notation/core@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies
  - @notation/core@0.5.1

## 0.4.1

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/core@0.5.0

## 0.4.0

### Minor Changes

- Load infra in runtime modules

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.1

## 0.3.2

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
