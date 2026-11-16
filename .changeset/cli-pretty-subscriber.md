---
"@notation/cli": minor
"@notation/core": minor
"@notation/reconciler": minor
---

`notation deploy`, `destroy` and `plan` print pretty output on a terminal or in CI (when `CI` is set and is not `false` or `0`), and JSON otherwise. When neither `--json` nor `--pretty` is passed and the output is JSON, the CLI prints a line on stderr that says so. `@notation/cli` requires Node 22.13 or later.

`createLoggerReconcilerSubscriber` prints the same one-line format as the CLI and takes an optional `style` function. The style function receives the event's level, so colours follow the stream the line is written to. `formatReconcilerEvent` is replaced by `formatPrettyEvent`. The subscriber no longer prints a separate "Took over …" line. `deployApp`, `destroyApp` and `planApp` use this subscriber when the caller passes no emitter, so their default output changes too.

A skipped read or delete emits only the `skip` event. It no longer emits `success` afterwards. `OperationLifecycleEvent["reason"]` is the union `OperationLifecycleReason`.
