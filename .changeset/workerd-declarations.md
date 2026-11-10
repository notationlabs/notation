---
"@notation/build": minor
"@notation/cli": minor
"@notation/resource": minor
---

The compiler can build Cloudflare Workers and Durable Object namespaces, for a provider package to declare with `$worker` and `$durableObject`.

- A `@declaration` mark without `entry:` gets no runtime bundle. `compileInfra()` returns such a module with no `entry`. Before, the entry defaulted to `handler`, so a project's own wrapper marked `@declaration` without `entry:` now gets no bundle, and no error. Add `entry: handler` to the mark. An empty `entry:` clause fails the build.
- The infra strip doesn't follow the names in `runtime:` options. A Durable Object class that `class: Counter` names, and its imports such as `cloudflare:workers`, are left out of the infra build.
- A `runtime:` option whose value is a name that the module declares or imports, such as `class: Counter`, becomes a function with that name in the infra build, so the declaration can read `config.class.name`. The name is the local name at the call site. Any other value, including a class expression, a method and a global such as `undefined`, becomes a function whose name is `""`. A method option, such as `class() {}`, no longer gives invalid code.
- The infra build fails on a `cloudflare:` import, such as `cloudflare:workers` in a module that the infra build keeps, and names the importing file. Before, the build warned, and the infra bundle failed when deploy imported it.
- The mark clause `platform: workerd` builds the runtime bundle for workerd: Rolldown's `neutral` platform, wrangler's conditions and `NODE_ENV` defines, and `cloudflare:` and `node:` imports left external. A bare Node built-in, such as `events`, that no package provides is imported as its `node:` module. A `require()` of a built-in, as in a CommonJS package, gets a module that imports the `node:` module, as wrangler does. The bundle re-exports the module's other value exports besides the entry, such as Durable Object classes, and not the declaration or types. `compileInfra()` returns the module with `platform` and `exports`.
- workerd doesn't start a Worker whose module exports a primitive, `null`, `undefined` or a module namespace object. The build fails, with the file and line, for an exported variable with a primitive initialiser, and for `export * as ns from`, in a `platform: workerd` module.
- For a `platform: workerd` declaration, the `declaredIn` record also holds `exports` and `starExports`, so the provider can check at plan time that the Worker exports each bound class under its name. `declaredIn()` takes them as a fourth argument, `moduleExports`.
- The runtime build marks each declaration call `/*#__PURE__*/`, so the bundler drops a declaration that the bundle doesn't use. The runtime half of a declaration function must have no side effects.
- In watch mode, a runtime bundle reads its module from disk when it builds, so a module that removes an export no longer logs a false build error before the infra rebuild restarts the runtime watcher. A module that loses its declaration, its entry or its entry export writes no bundle, and the last bundle stays.
- `createRuntimeEntry` is no longer exported from `@notation/build`.
- `@notation/build` exports `platformOf(name)`, which returns a platform's definition, the type `Platform` of that definition, and `PlatformName`, which is `"node" | "workerd"`. A definition holds the runtime bundle's Rolldown options, whether the runtime entry re-exports the module's other exports, and the platform's check of export values. `ModuleAnalyses.fromDisk(file)` analyses a module from its current source on disk.
- `DeclarationModule` is a union of its valid cases: no entry, an entry on Node, or an entry with `platform` and `exports`. The type of the `declaredIn` record, `DeclaredIn`, has both `exports` and `starExports` or neither. The record's runtime shape is the same.
