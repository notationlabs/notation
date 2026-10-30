---
"@notation/core": minor
"@notation/reconciler": minor
"@notation/resource": minor
"@notation/state": minor
"@notation/std.iac": minor
"@notation/aws.iac": minor
---

Migrate the durable runtime to yieldstar 0.8.0.

- `--execution-id` now reports the recorded error for a `failed` execution instead of replaying it. Start a new deploy to recover.
- When the workflow throws, the execution releases its deployment hold.
- The reconciler keeps the properties of a `create` or `read` result that the schema declares. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A `Buffer` or other class instance fails the step with `WorkflowValueError` (`INVALID_STEP_VALUE`).
- Databases, executions and tables from yieldstar 0.5 are not migrated.
- Each create attempt runs as a yieldstar `step.effect`. When the outcome of an attempt is unknown, the reconciler looks the resource up before it calls `create` again. The outcome is unknown after the process stops between `create` and the recorded result, or when `create` throws an error for which the resource's `isUncertainError` returns true. Create attempt step keys change from `*:create:remote:attempt:<n>` to `*:create:remote:effect:<n>`.

`@notation/resource` and `@notation/state`:

- `defineOperations` takes optional `findCreated(params, token)` and `isUncertainError(error)`. `create` receives the attempt's token as its third argument. `Resource.keyOf(output)` returns the key that `output` gives.
- `DurableValue`, `DurableObject` and `Durable<T>` describe the values the reconciler records. `Resource.toResult` keeps the properties of a provider result that the schema declares.
- A provider that returns a `Buffer` does not compile. `StateNode` holds durable values, and `ResourceOperationPendingError.callbackContext` is a `DurableObject`.

`@notation/std.iac` and `@notation/aws.iac`:

- The Zip and File outputs replace `file` with `fileSha256`.
- The Lambda's `Code` param is replaced by `CodeFilePath`.
- The Lambda's `CodeSha256` param holds a base64 SHA-256 of the uploaded bytes instead of a hex SHA-256 of the source. Drift detection no longer reports every Lambda. On the first deploy after the upgrade, each Lambda uploads its code once.
- An API Gateway API is tagged `notation:create-token` with a hash of its create token, and its read leaves the tag out of `Tags`. A Lambda function gets the same tag. After a create with an unknown outcome, the API is found by the tag, a route by its route key, and a Lambda function by its name and the tag. A function with the same name and without the tag fails the create instead of being taken over. An API, route or Lambda create that times out, loses its connection or gets a server error is looked up instead of failing the deploy.
