---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

The build sorts modules into three kinds: runtime modules, which call a declaration function such as `$lambda`; infra modules, which import a resource function such as `queue`, or import an infra module; and shared modules, which are all other modules. Both builds bundle shared modules as written, and the runtime build leaves infra modules out.

- `sharedModules` in `notation.config.ts` takes globs for modules that must be shared. The build fails if one of them calls a declaration function, imports a resource function, or imports an infra or runtime module. The error names the line of the import and why the imported module is infra or runtime. The check follows static imports and re-exports, not dynamic `import()`.
- An import that a module uses only in types doesn't make the module infra, with or without the `type` keyword.
- Errors that say a module is infra name the chain of imports that makes it infra, with the position of each import.
- The kinds apply to project modules: files outside `node_modules` that are under the project root, or outside it but not in a workspace package. The build doesn't follow imports into packages. A workspace package outside the project root keeps the rules from before: one of its modules is infra only if it calls a resource function at its top level, and the build still finds its `$lambda` modules.

Changes that can make a build fail that passed before:

- Infra is transitive. A module that imports an infra module is infra, even if the function uses only its other exports. A function that uses such a module now fails the build. Move the exports that the function uses to a module that doesn't import infra. Before, the bundler dropped the unused infra import and kept the module.
- A module that imports a resource function but calls it only inside a function, such as a factory `makeQueue(name)`, is infra, and so is a barrel such as `infra/index.ts` that re-exports infra. Before, only a module that called a resource function at its top level counted.
- The runtime build fails when a runtime module imports, only for its side effects, a module that is infra only through its imports, such as `import "./setup"` where `setup.ts` imports `infra/orders.ts`. The runtime build leaves infra modules out, so the setup code wouldn't run in the function. Before, such a module ran in the function. A side-effect import of a module that imports a resource function itself, such as `import "../infra/alarms"`, is still left out without an error.

API changes:

- `@notation/build`: `ModuleAnalyses` takes an options object, `{ marks, sharedModules, root }`. It has the `root` and `sharedModules` properties, and `kind()`, `describeKind()`, `checkShared()`, `checkEffectImports()`, `isProjectModule()` and `isListedShared()`. The new types are `ModuleKind`, `InfraReason`, `ModuleAnalysesOptions`, `ResourceImport` and `DescribeInfra`. `ModuleAnalysis.isInfra` is replaced by `resource`, the first resource function that the module imports, `resourceCall`, the first call to a resource function at its top level, and `valueNames`, the names that the module uses as values. `stripForRuntime` takes a `DescribeInfra` function in place of `IsInfraModule`, which is no longer exported, and an optional project root. Its errors name the file relative to the project root, not by its absolute path. `Marks` has `exportOrigin()` and `resourceExport()`.
- `@notation/core`: `Build` has an optional `sharedModules`, and `resolveSharedModules()` reads it from the config.
