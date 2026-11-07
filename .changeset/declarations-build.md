---
"@notation/build": minor
"@notation/cli": minor
"@notation/core": minor
---

The compiler is built on Rolldown, in place of esbuild (RFC 0015). `@notation/esbuild-plugins` is replaced by `@notation/build`.

- The builds find declaration functions by JSDoc marks in the packages that export them. `@declaration` marks a function that declares a function resource, such as `createLambda`, with the options that each build keeps. `@runtime` marks a function that builds part of an option, such as `sqs`, with the arguments that the runtime build keeps. `@resource` marks a resource function, such as `queue`. The builds follow imports, re-exports and `export *` to the module that has the mark.
- A declaration is written `const name = createLambda({ ... })` at the top level of its module, with an object literal that has no spread or computed keys. Any other call fails the build with its location, and so does a module with more than one declaration. A function that the user marks `@declaration` can call a declaration function inside it.
- The infra build runs a stripped copy of each declaration module that the infra entry reaches. The copy keeps the declaration and the top-level statements that it uses. The handler, SDK clients, top-level `await`, logging and side-effect imports are removed. The declaration is wrapped in `$declaredIn(...)`, which records the module's file URL and the name of its binding. The build fails if the module doesn't export `handler`.
- The runtime build bundles each declaration module to `dist/<module path>/index.mjs`, from a generated entry that re-exports `handler`. The declaration keeps only its runtime options: `event`, and the names of `env` without their values. Infra modules are marked free of side effects, so the bundler drops them. The build fails if a kept option refers to an infra module, or if an infra module is still in the bundle; the error names the import chain.
- Packages stay external in the infra bundle, as before. Imports through tsconfig `paths` are bundled.
- `compileInfra()` returns the declaration modules, as `{ path, binding, entry }`. `compile()` and `visualise()` take `{ entryPoint }`. `runtimeModules` in `notation.config.ts` is not used by the build yet; deploy finds declaration modules only through the infra entry.
