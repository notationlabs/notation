# @notation/std.iac

## 0.16.0

### Minor Changes

- 7d01d51: Migrate the durable runtime to yieldstar 0.8.2.

  - `--execution-id` now reports the recorded error for a `failed` execution instead of replaying it. Start a new deploy to recover.
  - When the workflow throws, the execution releases its deployment hold.
  - The reconciler keeps the properties of a `create` or `read` result that the schema declares. A `Date`, `Map`, `Set` or `bigint` is recorded as it is. A `Buffer` or other class instance fails the step with `WorkflowValueError` (`INVALID_STEP_VALUE`).
  - Databases, executions and tables from yieldstar 0.5 are not migrated.
  - Each create attempt runs as a yieldstar `step.effect`. When the outcome of an attempt is unknown, the reconciler looks the resource up before it calls `create` again. The outcome is unknown after the process stops between `create` and the recorded result, or when `create` throws `ResourceCreationUnknownError`. Create attempt step keys change from `*:create:remote:attempt:<n>` to `*:create:remote:effect:<n>`.

  `@notation/resource` and `@notation/state`:

  - `defineOperations` takes an optional `find(params, token)`. `create` throws the new `ResourceCreationUnknownError` when it cannot tell whether the provider made the resource. `create` receives the attempt's token as its third argument. `Resource.keyOf(output)` returns the key that `output` gives.
  - `DurableValue`, `DurableObject` and `Durable<T>` describe the values the reconciler records. `Resource.toResult` keeps the properties of a provider result that the schema declares.
  - A provider that returns a `Buffer` does not compile. `StateNode` holds durable values, and `ResourceOperationPendingError.callbackContext` is a `DurableObject`.

  `@notation/std.iac` and `@notation/aws.iac`:

  - The Zip and File outputs replace `file` with `fileSha256`.
  - The Lambda's `Code` param is replaced by `CodeFilePath`.
  - The Lambda's `CodeSha256` param holds a base64 SHA-256 of the uploaded bytes instead of a hex SHA-256 of the source. Drift detection no longer reports every Lambda. On the first deploy after the upgrade, each Lambda uploads its code once.
  - An API Gateway API is tagged `notation:create-token` with a hash of its create token, and its read leaves the tag out of `Tags`. A Lambda function gets the same tag. After a create with an unknown outcome, the API is found by the tag, a route by its route key, and a Lambda function by its name and the tag. A function with the same name and without the tag fails the create instead of being taken over. An API, route or Lambda create that times out, loses its connection or gets a server error is looked up instead of failing the deploy.
  - An API Gateway integration or authorizer cannot be looked up. After a create with an unknown outcome, the next deploy can create a second one that Notation does not record or delete. See the API Gateway docs.

### Patch Changes

- Updated dependencies [19a9d2e]
- Updated dependencies [7d01d51]
  - @notation/resource@0.16.0
  - @notation/core@0.16.0
  - @notation/utils@0.16.0

## 0.15.0

### Minor Changes

- 4fe4451: Paths are now relative to the project root (the nearest directory with a package.json, starting from the working directory), not the working directory. This covers deployment IDs, Lambda IDs, build output, the state database and the files that file and zip resources read. You can run the CLI from any folder inside the project and get the same result.

  This is a breaking change. Deployment IDs used to be absolute paths, so Notation will not find the state of existing deployments. Destroy them before upgrading, or redeploy and delete the old resources by hand.

### Patch Changes

- Updated dependencies [bddd9f8]
- Updated dependencies [18c2b4c]
- Updated dependencies [83f0de1]
- Updated dependencies [16a0209]
- Updated dependencies [425f8ba]
- Updated dependencies [b290eb1]
- Updated dependencies [4fe4451]
- Updated dependencies [7a90e6b]
- Updated dependencies [6508511]
- Updated dependencies [6943418]
  - @notation/resource@0.15.0
  - @notation/core@0.15.0
  - @notation/utils@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [9afdb3c]
  - @notation/resource@0.14.0
  - @notation/core@0.14.0
  - @notation/utils@0.14.0

## 0.13.0

### Minor Changes

- f7e9186: A resource `read` now returns the remote object or throws the tagged `ResourceNotFoundError`. Operations that have started but not settled throw `ResourceOperationPendingError` with their retry delay and optional callback context. The reconciler follows those explicit instructions instead of guessing retry behaviour from provider errors or call-site context.

### Patch Changes

- Updated dependencies [b7119a8]
- Updated dependencies [f7e9186]
  - @notation/core@0.13.0
  - @notation/resource@0.13.0
  - @notation/utils@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @notation/core@0.12.0
  - @notation/resource@0.12.0

## 0.11.1

### Patch Changes

- Hide large buffers from state file
- Updated dependencies
  - @notation/core@0.11.1

## 0.11.0

### Patch Changes

- @notation/core@0.11.0

## 0.10.0

### Minor Changes

- Fix package versions

### Patch Changes

- Updated dependencies
  - @notation/core@0.10.0

## 0.6.1

### Patch Changes

- Updated dependencies
  - @notation/core@0.6.1

## 0.6.0

### Minor Changes

- Support externally managed lambda modules

## 0.5.0

### Minor Changes

- 2a6fc59: Add optional JWT authorizer config to route resource

### Patch Changes

- Updated dependencies [2a6fc59]
  - @notation/core@0.6.0

## 0.4.3

### Patch Changes

- Updated dependencies
  - @notation/core@0.5.1

## 0.4.2

### Patch Changes

- Updated dependencies [5debdd1]
  - @notation/core@0.5.0

## 0.4.1

### Patch Changes

- Removed dev artifacts from dist
- Updated dependencies
  - @notation/core@0.4.1

## 0.4.0

### Minor Changes

- Stateful deployments

### Patch Changes

- Updated dependencies
  - @notation/core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [b75f89b]
  - @notation/core@0.3.1

## 0.3.0

### Minor Changes

- Prepare for release

### Patch Changes

- Updated dependencies
  - @notation/core@0.3.0
