---
"@notation/cli": minor
"@notation/core": patch
"@notation/reconciler": patch
---

`notation deploy`, `destroy` and `plan` print JSON when stdout is not a terminal, and pretty output on a terminal. `--json` and `--pretty` choose the format. Pretty output prints each reconciler event as one line with a status symbol, and leaves out noop decisions. A deploy without `--json` still asks for secret values when stdin is a terminal.
