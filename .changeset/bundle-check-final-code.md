---
"@notation/build": patch
"@notation/cli": patch
---

The runtime build's bundle check describes the final code of the bundle. The check uses Rolldown's per-module render info, which describes the code before the `"dce-only"` minify pass that Rolldown runs by default. That pass can drop a call to a function without effects, and the function with it. The check then reported an infra module or a resource function that the bundle didn't contain.

The runtime build now sets `minify: false`, so the render info matches the final code. `runtimePlugin()` fails the build if the output options don't set `minify: false`. Lambda bundles are about 7% larger, because they keep code that the minify pass dropped, such as unused functions from valibot.
