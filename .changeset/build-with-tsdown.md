---
"@notation/aws": patch
"@notation/aws.iac": patch
"@notation/cli": patch
"@notation/core": patch
"@notation/dashboard": patch
"@notation/esbuild-plugins": patch
"@notation/reconciler": patch
"@notation/resource": patch
"@notation/state": patch
"@notation/std.iac": patch
"@notation/utils": patch
"create-notation": patch
---

The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
