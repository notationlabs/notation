---
"@notation/core": minor
"@notation/aws": patch
"@notation/std": patch
"@notation/resource": patch
"@notation/utils": patch
"create-notation": patch
---

`@notation/aws`, `@notation/std`, `@notation/resource` and `@notation/utils` declare `"sideEffects": false`. A bundler can now drop these packages from a Lambda bundle when the runtime code doesn't use them.

`@notation/aws/resources` constructs each AWS SDK client when it is first used, not when the module loads. `@notation/aws/resources` and `@notation/std/resources` import the project path helpers from the new `@notation/core/paths` subpath, so they no longer load the deploy engine, esbuild, pino and yieldstar.

The starter template sets `"types": ["node"]` and installs `@types/node`. It used to get the Node types through `@notation/core`.
