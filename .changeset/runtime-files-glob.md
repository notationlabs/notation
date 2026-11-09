---
"@notation/core": minor
"create-notation": patch
---

Runtime modules are found by their declaration, such as `$lambda`, in the files that `files.runtime` in `notation.config.ts` matches. The default is `runtime/**`. This replaces the fixed `runtime/**/*.fn.ts` glob, so a runtime module's file name doesn't need a `.fn` ending. The starter's runtime module is `runtime/todos.ts`.
