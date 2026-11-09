---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

Each module's kind comes from globs in `files` in `notation.config.ts`. The kinds are `infra`, `runtime` and `shared`. The defaults are `infra/**`, `runtime/**` and `shared/**`, and each key replaces only its own default. A `!` glob excludes files from a kind.

```ts
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  files: { runtime: ["runtime/**", "jobs/*.ts"], shared: ["lib/**"] },
});
```

- An infra module is left out of each function's bundle, even if it calls no resource function. A project file that no glob matches keeps its top-level code, so if it calls a resource function at its top level, such as `export const dlq = queue(...)` in `lib/queues.ts`, a function that imports it fails the build. Add the file to `files.infra`. Package files, including workspace packages and folders below the root with a named `package.json`, are infra if they call a resource function at their top level.
- A shared module fails the build if it declares a function, imports a resource function, or imports an infra or runtime module, directly or through modules that aren't infra or runtime. The error names the chain of imports with the position of each import. Projects with a `shared/` folder are checked by default.
- A file that two kinds match fails the build, even if nothing imports it. The error names the file and both globs, and says which glob is a default. For example, `files: { infra: ["**/*.ts"] }` conflicts with the default `files.runtime`.
- A declaration, such as `$lambda`, in an infra or shared module fails the build. A declaration in a file that no glob matches still works when infra imports it.
- Errors that name an infra module say why it is infra, such as `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`.
- `@notation/core` adds `NotationConfig.files`, `Build.files`, `ModuleFiles`, `ModuleGlobs`, `ModuleKind`, `moduleKinds`, `defaultModuleGlobs` and `resolveModuleGlobs()`.
- `@notation/build` adds `FileKinds` and `KindMatch`. `ModuleAnalyses` takes `{ marks?, files? }` and has `kindOf()`, `describeInfra()`, `checkDeclaration()`, `checkShared()` and `show()`.
