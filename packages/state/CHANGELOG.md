# @notation/state

## 0.17.0

### Minor Changes

- e4f4157: `resource()` now requires `provider`, the name of the package that exports the resource class. Each state record stores it, so that deploy and destroy can delete a record whose type is no longer in code.

  ```ts
  const queue = resource<QueueSchema>({
    type: "aws/sqs/Queue",
    provider: "@notation/aws/resources",
  });
  ```

  This breaks every resource class outside this repository: a class without `provider` fails type checking.

  - A provider is a package or a package subpath that exports resource classes, or namespaces of them. Its entry has a `default` condition in `exports`, so that it can be resolved with `require` conditions. `@notation/aws/resources` and `@notation/std/resources` do both.
  - `planApp`, `deployApp` and `destroyApp` in `@notation/core` load the provider packages of the state records whose type has no class in code. A package that can't be resolved or that throws on import is skipped with a `reconciler.provider.load-failed` warning, and its records stay in state.
  - Before, an orphan whose type was no longer in code was left in place. Deploy now deletes it through the class of its provider package. This removes the limit on renaming an EventBridge bus in the deploy that removes its last rule.
  - A resource whose ID is that of a state record of another type fails plan, deploy and destroy with `ResourceTypeChangedError`, before any change. A provider that changes a resource's type must give it a new ID.
  - State written by an earlier version is not supported, as its records have no `provider`. Destroy the stack with the earlier version before you upgrade.

### Patch Changes

- ae3d823: The packages are built with tsdown instead of tsup. The entry points and their types are at the same paths. Shared code sits in chunks with different names, and imports of Node built-ins keep their `node:` prefix. The `@notation/aws` entry points now share chunks instead of each bundling its own copy, so they share module state.
- Updated dependencies [ae3d823]
- Updated dependencies [614ce3f]
- Updated dependencies [ce76cd5]
- Updated dependencies [d00b769]
- Updated dependencies [8839f28]
- Updated dependencies [f490162]
- Updated dependencies [e9da750]
- Updated dependencies [e4f4157]
- Updated dependencies [f490162]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [3fefade]
- Updated dependencies [ce76cd5]
- Updated dependencies [121442b]
- Updated dependencies [4776f9f]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/resource@0.17.0

## 0.16.0

### Minor Changes

- 35196ff: Each state record stores the IDs of the resources it depends on in `dependsOn`. Deploy and destroy delete orphans in reverse order of these edges, so removing a construct such as a Lambda deletes its policy attachment before its role. A resource whose edges change but whose params do not has only `dependsOn` rewritten, with no provider call. Records written before this change have no edges until the next deploy writes them, and until then are deleted in storage order. Destroy deletes orphans before the resources in the desired set, so an orphan is deleted before a resource it depends on. When an orphan's type is not registered, the orphans it depends on are kept too, and in destroy so are the resources in the desired set that it depends on. `reconciler.orphan-deletion.skipped` names them in `keptDependencies`. A plan node lists `dependsOn` sorted and deduplicated. `CreateResourceParams` and `UpdateResourceParams` take a required `dependsOn`.
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

## 0.15.0

## 0.14.0

## 0.13.0

### Minor Changes

- b7119a8: Add durable Yieldstar 0.5.0 deploy and destroy workflows, a resident Node SQLite runtime for CLI execution, versioned event streams, backend-neutral dashboard state, and compiled infrastructure graphs.

## 0.12.0
