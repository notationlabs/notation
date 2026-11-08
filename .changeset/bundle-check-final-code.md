---
"@notation/build": patch
---

The runtime build's bundle check reads the final code of the bundle. It used Rolldown's per-module render info, which describes the code before the `"dce-only"` minify pass. That pass can drop a call to a function without effects, and the function with it. The check then reported an infra module or a resource function that the bundle didn't contain.

The check now reads the chunk's source map, which describes the code after that pass. If the build doesn't ask for a source map, the plugin generates one for the check and doesn't write it.
