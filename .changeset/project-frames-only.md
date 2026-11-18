---
"@notation/cli": patch
"@notation/core": patch
---

When a command fails with an error that is not a failed operation, the CLI prints the error's name and message and the stack frames of the project's own files. A frame counts when its file is under the project root and outside `node_modules`. The CLI prints each cause the same way, on a line that starts with `Caused by:`, and each error of an `AggregateError` indented below it. Before, the CLI printed the full stack, with the frames of notation, its dependencies and Node. `NOTATION_DEBUG=1` still prints the error unchanged.

The config is bundled with an inline source map, so its frames name `notation.config.ts` and its lines, not the temporary bundle under `node_modules/.cache/notation`.
