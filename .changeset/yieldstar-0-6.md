---
"@notation/core": minor
"@notation/reconciler": minor
---

Migrate the durable runtime to yieldstar 0.6.

- `--execution-id` now reports the recorded error for a `failed` execution instead of replaying it. Start a new deploy to recover.
- When the workflow throws, the execution releases its deployment hold.
- Provider operation results and resource output must be durable values. A `Date`, `Buffer` or other class instance fails the step with `WorkflowValueError` (`INVALID_STEP_VALUE`).
- Databases, executions and tables from yieldstar 0.5 are not migrated.
