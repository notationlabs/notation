---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

Each module's kind comes from globs in `files` in `notation.config.ts`. The kinds are `infra`, `runtime` and `shared`. The defaults are `infra/**`, `runtime/**` and `shared/**`, and each key replaces only its own default. A `!` glob excludes files from a kind. A glob that ends in `/` matches the files in that folder. A glob with no `*`, `?`, `[` or `{`, such as `"infra"`, matches that path and the files under it.

```ts
export default defineConfig({
  app: "todos",
  entry: "infra/index.ts",
  files: { runtime: ["runtime/**", "jobs/*.ts"], shared: ["lib/**"] },
});
```

- **An infra module never runs in a function.** The runtime build leaves out every file that `files.infra` matches, even one that calls no resource function. A function that uses any value from such a file fails the build, even a plain constant. The error says to move the value to a shared module. Code that the function needs belongs in a shared module, or in a file that no glob matches.
- **A setup module under `infra/` doesn't run in the function.** For example, `infra/setup.ts` sets a global, and a runtime module imports it with `import "../infra/setup"`. The runtime build leaves `infra/setup.ts` out, even though it calls no resource function, and the build doesn't fail. Move code that the function needs to a shared module, or to a file that no glob matches.
- **Projects with infra outside `infra/` need `files.infra`.** Only `files.infra` makes a project file infra. A file that it doesn't match keeps its top-level code in the function, so if the file calls a resource function at its top level, such as `export const dlq = queue(...)` in `src/queues.ts`, a function that imports it fails the build. The error names the file and says to add it to `files.infra`, or, if the file holds a declaration, to move the call to an infra module. A kept option of a declaration that refers to a value from such a file, such as `event: () => sqs(dlq)`, fails the build at the option's line. That error says to move a plain value that the option uses to a shared module, or to a file that no glob matches.
- **A package file is never infra.** This includes files of workspace packages, and of folders below the root with a named `package.json`. If a package file calls a resource function at its top level, and its package doesn't set `"sideEffects": false`, the file stays in the function and the bundle check fails. For a workspace package or a package folder, the error says to add `"sideEffects": false` to the package's `package.json`, such as `packages/api/package.json`. If the package already sets it, the function uses a value from the file, and the error says to read infra values through the declaration's `env()`. An installed package in `node_modules` gets no advice. A kept option that refers to a value from a package file fails at the option's line, as for a file that no glob matches.
- A shared module that either build includes fails the build if it declares a function, imports a resource function, or imports an infra or runtime module, directly or through modules that aren't infra or runtime. An import counts if the module uses it as a value, including as a JSX tag such as `<Comp />`. The error names the chain of imports with the position of each import. Projects with a `shared/` folder are checked by default.
- A file that two kinds match fails the build, even if nothing imports it. The error names the file and both globs, and says which glob is a default. For example, `files: { infra: ["**/*.ts"] }` conflicts with the default `files.runtime`.
- A declaration, such as `$lambda`, in an infra or shared module fails the build. A declaration in a file that no glob matches still works when infra imports it.
- Errors that name an infra module say why it is infra, such as `infra/orders.ts, an infra module (files.infra: "infra/**", the default)`. Errors quote a glob as the config writes it.
- `@notation/core` adds `NotationConfig.files`, `Build.files`, `ModuleFiles`, `ModuleGlobs`, `ModuleKind`, `moduleKinds`, `defaultModuleGlobs` and `resolveModuleGlobs()`.
