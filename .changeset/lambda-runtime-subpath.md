---
"@notation/aws": minor
"@notation/esbuild-plugins": minor
---

`@notation/aws/lambda.fn` moves to `@notation/aws/lambda/runtime`. A runtime module imports `handle`, `createDispatcher` and the handler types from the new path. The generated function entry imports the dispatcher from `@notation/<platform>/<service>/runtime`.
