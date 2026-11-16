---
"@notation/build": minor
"@notation/aws": minor
"@notation/cloudflare": minor
"@notation/cli": minor
---

`@notation/build/resources` exports `bundle()` and the `Bundle` resource. A bundle takes an entry and generated modules, and deploy builds it with Rolldown, with the build options of a `$lambda` or `$worker` bundle. Its params hold the hash of the file that it writes, and its outputs have the shape of a `std.fs.File`. `BundleLike` and `isBundle()` describe and recognise a bundle, including one from another installed copy of the package. Each build writes `dist/.bundles/<id>/inputs.json`, so a plan skips the build when no input has changed.

- `lambda()` accepts a bundle built for `node` as its `code`, and calls `index.<handler>`. `@notation/aws` and `@notation/cloudflare` now depend on `@notation/build`.
- `@notation/cloudflare/workers` exports `worker()`, which declares a Worker whose code is a bundle built for `workerd`. It binds the same values as `$worker`, and hosts a Durable Object namespace whose class the bundle's entry exports.
- `notation watch` redeploys when a file that a bundle read changes, outside `node_modules`.
- `@notation/build` exports `functionBuildOptions()`, the full Rolldown options of a function's bundle. The runtime builds of `notation compile` now run with the real path of the project root as their `cwd`. In a project whose root path is a symlink, the code of each existing `$worker` and `$lambda` changes once, because Rolldown writes paths in the output relative to `cwd`. The next deploy redeploys each of these functions once.
