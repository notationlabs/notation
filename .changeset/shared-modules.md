---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

Add `sharedModules` to `notation.config.ts`. It takes globs for modules that must stay free of infra in both builds. The build fails if a listed module, or a project module that it imports directly or through other project modules, declares a function or imports a resource function. The error names the chain of imports, with the position of each import. The check skips imports used only in types, stops at workspace packages, and doesn't follow imports into `node_modules`.

Module kinds are unchanged from before: a module is infra only if it calls a resource function at its top level, and a module's imports don't change its kind.

Other changes:

- The runtime build's errors for an infra module left in the bundle say why the module is infra, with the position of the call. The chain of imports follows dynamic `import()` too, and names the infra module closest to the function's module.
- When a kept declaration option refers to a plain value that an infra module re-exports, the error names the module that defines the value.
- A module with a declaration is a runtime module even if it also calls a resource function at its top level. Before, the runtime build also counted it as infra and failed on it as an infra module in the bundle. Now the check for resource functions from packages fails on the call instead.
- Errors name a project module outside the project root by its relative path, such as `../common/fmt.ts`, in every part of the message.

API changes:

- `@notation/build`: `ModuleAnalyses` takes an options object, `{ marks, sharedModules, root }`. It has the `root` and `sharedModules` properties, and `kind()`, `describeKind()`, `checkShared()`, `isProjectModule()` and `isListedShared()`. The new types are `ModuleKind`, `ModuleAnalysesOptions`, `ResourceImport` and `DescribeInfra`. `ModuleAnalysis.isInfra` is replaced by `resourceCall`, the first call to a resource function at its top level. `ModuleAnalysis` also has `resource`, the first resource function that the module imports, and `valueNames`, the names that the module uses as values. `stripForRuntime` takes a `DescribeInfra` function in place of `IsInfraModule`, which is no longer exported, and an optional project root. Its errors name the file relative to the project root, not by its absolute path. `Marks` has `exportOrigin()` and `resourceExport()`.
- `@notation/core`: `Build` has an optional `sharedModules`, and `resolveSharedModules()` reads it from the config.
