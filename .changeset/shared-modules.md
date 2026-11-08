---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

The build sorts modules into three kinds: runtime modules, which call a declaration function such as `$lambda`; infra modules, which import a resource function such as `queue`, or import an infra module; and shared modules, which are all other modules. Both builds bundle shared modules as written, and the runtime build leaves infra modules out.

- Infra is transitive. A barrel such as `infra/index.ts` that re-exports infra is an infra module, and so is a module that imports a resource function but calls it only inside a function. Before, only a module that called a resource function at its top level counted.
- `sharedModules` in `notation.config.ts` takes globs for modules that must be shared. The build fails if one of them calls a declaration function, imports a resource function, or imports an infra or runtime module. The error names the line of the import and why the imported module is infra or runtime.
- An import that a module uses only in types doesn't make the module infra, with or without the `type` keyword.
- The runtime build fails when a runtime module imports an infra module only for its side effects, such as `import "./setup"`. The runtime build leaves infra modules out, so that code wouldn't run in the function. Before, such a module kept its side effects unless it called a resource function at its top level.
- Errors that say a module is infra name the chain of imports that makes it infra, with the position of each import.
- Packages have no kind. The build doesn't follow imports into `node_modules` or into a workspace package outside the project root. Files under the project root are project modules, even in a folder with its own `package.json`.
- `@notation/build`: `ModuleAnalyses` takes an options object, `{ marks, sharedModules, root }`, and has `kind()`, `describeKind()`, `checkShared()`, `checkEffectImports()`, `isProjectModule()` and `isListedShared()`. The new types are `ModuleKind`, `InfraReason`, `ModuleAnalysesOptions`, `ResourceImport` and `DescribeInfra`. `ModuleAnalysis.isInfra` is replaced by `resource`, the first resource function that the module imports, and `valueNames`, the names that the module uses as values. `stripForRuntime` takes a `DescribeInfra` function in place of `IsInfraModule`, and an optional project root. `Marks` has `exportOrigin()` and `resourceExport()`.
- `@notation/core`: `Build` has an optional `sharedModules`, and `resolveSharedModules()` reads it from the config.
