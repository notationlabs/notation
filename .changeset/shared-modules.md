---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

The build sorts modules into three kinds: runtime modules, which call a declaration function such as `$lambda`; infra modules, which import a resource function such as `queue`, or import an infra module; and shared modules, which are all other modules. Both builds bundle shared modules as written, and the runtime build leaves infra modules out.

- `sharedModules` in `notation.config.ts` takes globs for modules that must be shared. The build fails if one of them calls a declaration function, imports a resource function, or imports an infra or runtime module. The error names the line of the import and why the imported module is infra or runtime. The check follows static imports and re-exports, not dynamic `import()`.
- An import that a module uses only in types doesn't make the module infra, with or without the `type` keyword.
- Errors that say a module is infra name the chain of imports that makes it infra, with the position of each import.
- The kinds apply to project modules: files outside `node_modules` that are under the project root, or outside it but not in a workspace package. The build doesn't follow imports into packages. A workspace package outside the project root keeps the rules from before: one of its modules is infra only if it calls a resource function at its top level, and the build still finds its `$lambda` modules. A project module that imports such an infra module directly is infra. One that imports it through the package's barrel isn't.

Changes that can make a build fail that passed before:

- Infra is transitive. A module that imports an infra module is infra, even if the function uses only its other exports. This includes a direct import of a workspace package module that calls a resource function at its top level. A function that uses such a module now fails the build. Move the exports that the function uses to a module that doesn't import infra. Before, the bundler dropped the unused infra import and kept the module.
- A module that imports a resource function but calls it only inside a function, such as a factory `makeQueue(name)`, is infra, and so is a barrel such as `infra/index.ts` that re-exports infra. Before, only a module that called a resource function at its top level counted.
- The runtime build fails when a runtime module loads an infra module only through side-effect imports and `export *`, and the infra module has top-level code that may have effects, such as `import "./setup"` where `setup.ts` sets a global and imports `infra/orders.ts`. The runtime build leaves infra modules out, so that code wouldn't run in the function. Before, it ran. The check follows the side-effect imports and `export *` of a module without such code, such as a barrel. A module whose top-level code is only imports, re-exports, types, function declarations, and classes and variables with literal or function values passes, and so does a module that calls a resource function at its top level, such as `infra/alarms.ts`.

Changes in what runs in the function:

- A module that is infra only through its imports, or that imports a resource function without calling it at its top level, is left out of the function's bundle when the function doesn't use its exports. Its top-level code no longer runs in the function. The build fails only in the case above. It doesn't fail when the function's code imports a name from such a module and the bundle drops the code that uses it, or when a module that is left out is the only importer of another module, which the bundler then leaves out too, even if it is shared.

API changes:

- `@notation/build`: `ModuleAnalyses` takes an options object, `{ marks, sharedModules, root }`. It has the `root` and `sharedModules` properties, and `kind()`, `describeKind()`, `checkShared()`, `checkEffectImports()`, `isProjectModule()` and `isListedShared()`. The new types are `ModuleKind`, `InfraReason`, `ModuleAnalysesOptions`, `ResourceImport` and `DescribeInfra`. `ModuleAnalysis.isInfra` is replaced by `resource`, the first resource function that the module imports, `resourceCall`, the first call to a resource function at its top level, and `valueNames`, the names that the module uses as values. `stripForRuntime` takes a `DescribeInfra` function in place of `IsInfraModule`, which is no longer exported, and an optional project root. Its errors name the file relative to the project root, not by its absolute path. `Marks` has `exportOrigin()` and `resourceExport()`.
- `@notation/core`: `Build` has an optional `sharedModules`, and `resolveSharedModules()` reads it from the config.
