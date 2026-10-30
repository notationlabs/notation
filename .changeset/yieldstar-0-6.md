---
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
"@notation/state": minor
"@notation/std.iac": minor
"@notation/aws.iac": minor
---

Migrate the durable runtime to yieldstar 0.6.

- `--execution-id` now reports the recorded error for a `failed` execution instead of replaying it. Start a new deploy to recover.
- When the workflow throws, the execution releases its deployment hold.
- The reconciler keeps the properties of a `create` or `read` result that the schema declares, and records each `Date` as an ISO 8601 string. A `Buffer` or other class instance fails the step with `WorkflowValueError` (`INVALID_STEP_VALUE`).
- Databases, executions and tables from yieldstar 0.5 are not migrated.

`@notation/resource` and `@notation/state`:

- `DurableValue`, `DurableObject` and `Durable<T>` describe the values the reconciler records. `toDurable` and `Resource.toResult` encode a provider result.
- Output, state and params types show a `Date` as a string. A provider may still return a `Date`, but a provider that returns a `Buffer` does not compile. `StateNode` holds durable values, and `ResourceOperationPendingError.callbackContext` is a `DurableObject`.

`@notation/std.iac` and `@notation/aws.iac`:

- The Zip and File outputs replace `file` with `fileSha256`.
- The Lambda's `Code` param is replaced by `CodeFilePath`.
- The Lambda's `CodeSha256` param holds a base64 SHA-256 of the uploaded bytes instead of a hex SHA-256 of the source. Drift detection no longer reports every Lambda. On the first deploy after the upgrade, each Lambda uploads its code once.
