---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

Each module's kind now comes from globs in `files` in `notation.config.ts`, in place of `runtimeModules`. The kinds are `infra`, `runtime` and `shared`. The defaults are `infra/**`, `runtime/**` and `shared/**`, and each key replaces only its own default.

```ts
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  files: { runtime: ["runtime/**", "jobs/*.ts"], shared: ["lib/**"] },
});
```

## Breaking changes

- `runtimeModules` is removed. A config that sets it fails with `unknown key "runtimeModules"`. Use `files.runtime`. Its default is `runtime/**`, in place of `runtime/**/*.ts`, so the scan also reads `.tsx`, `.js` and other JS and TS files in `runtime/`.
- The runtime build no longer infers infra from a project file's code. A file that `files.infra` matches is left out of each function's bundle, even if it calls no resource function. A project file that no glob matches keeps its top-level code, so if it calls a resource function at its top level, such as `export const dlq = queue(...)` in `lib/queues.ts`, a function that imports it now fails the build. Add the file to `files.infra`. Package files, including workspace packages and folders below the root with a named `package.json`, keep the old inference.
- A file that two kinds match fails the build, even if nothing imports it. The error names the file and both globs, and says which glob is a default. For example, `files: { infra: ["**/*.ts"] }` conflicts with the default `files.runtime`.
- A declaration, such as `$lambda`, in an infra or shared module fails the build. A declaration in a file that no glob matches still works when infra imports it.
- A shared module fails the build if it declares a function, imports a resource function, or imports an infra or runtime module, directly or through modules that aren't infra or runtime. The error names the chain of imports with the position of each import. Existing projects with a `shared/` folder are checked from this release on.
- Errors that name an infra module now say why it is infra, such as `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`.

## API changes

- `@notation/core`: `NotationConfig.files`, `ModuleFiles`, `ModuleGlobs`, `ModuleKind`, `moduleKinds`, `defaultModuleGlobs` and `resolveModuleGlobs()` are new. `resolveRuntimeModules()` and `defaultRuntimeModules` are removed. `Build.runtimeModules` is replaced by `Build.files`, the globs that the config sets.
- `@notation/build`: `FileKinds` and `KindMatch` are new. `new ModuleAnalyses()` takes an options object, `{ marks?, files? }`, in place of a `Marks`, and has `files`, `kindOf()`, `describeInfra()`, `checkDeclaration()`, `checkShared()` and `show()`. `infraEntryPlugin()` takes `{ analyses, entryPoint }`, and reads the root and the runtime globs from `analyses.files`. `ModuleAnalysis.isInfra` is replaced by `resourceCall`, the first call to a resource function at the top level. `stripForRuntime()` takes a `DescribeInfra` function, which returns why a module is infra, in place of `IsInfraModule`.
- `@notation/cli`: `compile()` takes `files` from `Build`. `compileInfra()` no longer takes `runtimeModules`. It reads the kinds from `analyses`, which defaults to the default globs, so it now scans `runtime/**` by default.
