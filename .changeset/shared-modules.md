---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

The build sorts modules into three kinds: runtime modules, which call a declaration function such as `$lambda`; infra modules, which import a resource function such as `queue`, or import an infra module; and shared modules, which are all other modules. Both builds bundle shared modules as written, and the runtime build leaves infra modules out.

- Infra is transitive. A barrel such as `infra/index.ts` that re-exports infra is an infra module, and so is a module that imports a resource function but calls it only inside a function. Before, only a module that called a resource function at its top level counted.
- `sharedModules` in `notation.config.ts` takes globs for modules that must be shared. The build fails if one of them calls a declaration function, imports a resource function, or imports an infra or runtime module. The error names the line of the import and why the imported module is infra or runtime.
- Errors that say a module is infra name the chain of imports that makes it infra.
- Packages have no kind. The build doesn't follow imports into `node_modules` or into another workspace package.
- `@notation/build`: `ModuleAnalyses` takes an options object, `{ marks, sharedModules, root }`, and has `kind()`, `describeKind()` and `checkShared()`. `ModuleAnalysis.isInfra` is replaced by `resource`, the first resource function that the module imports. `stripForRuntime` takes a `DescribeInfra` function in place of `IsInfraModule`.
- `@notation/core`: `Build` has an optional `sharedModules`, and `resolveSharedModules()` reads it from the config.
