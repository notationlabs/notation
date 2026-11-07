---
"@notation/core": minor
"create-notation": patch
---

`runtimeModules` in `notation.config.ts` defaults to `runtime/**/*.ts`, in place of `**/*.fn.ts`. A runtime module is found by its declaration, such as `$lambda`, so its file name doesn't need a `.fn` ending. The starter's runtime module is `runtime/todos.ts`.
