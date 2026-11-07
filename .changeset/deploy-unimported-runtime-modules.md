---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": patch
---

Deploy now includes runtime modules that infra doesn't import. The infra build reads each file that matches `runtimeModules` in `notation.config.ts`. The infra bundle imports the entry first, and then each of these files that calls a declaration function, such as `$lambda`. A file without a declaration is not imported.

- `infraEntryPlugin()` and `infraEntry` in `@notation/build` generate this entry. `findRuntimeDeclarations()` returns the runtime files that hold a declaration.
- `compile()` and `compileInfra()` take `runtimeModules`. Without it, the build finds declaration modules only through the entry's imports.
- In watch mode, the base directory of each glob is watched, or its nearest existing parent, so a new runtime file is deployed without a restart.
- The scan and the infra watcher skip `dist/`, `node_modules/` and dot-directories at any depth. `infraWatchExclude()` builds the watcher's pattern.
- A file in the globs that can't be parsed fails the build, and the error names the file.
