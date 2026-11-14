# @notation/cloudflare

## 0.21.0

### Minor Changes

- de720c2: `@notation/cloudflare/resources` exports `cloudflare/containers/ContainerImage`, which builds a container image with Docker and pushes it to the account's Cloudflare registry, `registry.cloudflare.com/<account>/<Repository>`.

  - `Context` is the build context directory, and `Dockerfile` defaults to `Dockerfile` in it. Both are relative to the project root. `BuildArgs` are passed to `docker build --build-arg`.
  - The output `Image` is the image pinned by its digest. Place `image.outputRef("Image")` in a `ContainerApplication`'s `Configuration.image`. The application then depends on the image.
  - The tag is the start of a SHA-256 of the files in the build context, the Dockerfile, the build args and the platform. When any of them changes, deploy replaces the image: it builds and pushes the image under the new tag, then rolls out the new digest to the application. Plan and deploy skip each `.git` directory when they hash the context, and don't read `.dockerignore`. Base images are not part of the hash.
  - Deploy runs `docker info`, `docker build --load --platform linux/amd64 --provenance=false`, `docker login` and `docker push`. Docker, with buildx, must be installed and running on the machine that deploys. `docker login` saves credentials in the user's Docker config that expire after 15 minutes.
  - Each read gets the tag's digest from the registry. A read requests short-lived pull credentials, so plan needs a token with the Containers: Edit permission. When the registry no longer has the tag, deploy builds and pushes the image again.
  - Delete leaves the image in the registry, because Cloudflare may still start instances from the old digest while a rollout of the new digest runs.

- f71b13d: `$durableObject` takes `container`, which runs a container for each object of the namespace. It sets the image (`context`, `dockerfile`, `buildArgs` and `repository`), `maxInstances`, and the size, environment variables and network of the containers. The hosting Worker's group then has a `ContainerImage` and a `ContainerApplication` for the namespace, and the Worker's upload sends the class in `containers`. The application is named `<app>-<stage>-<id>-<hash>`, as Cloudflare refuses a name with `--`. A namespace without `container` has no `container` key, so the params of a Worker that was deployed before this change stay the same.
- 3cf5a05: `@notation/cloudflare/resources` exports the resource `cloudflare/kv/KVValue`, which sets the value of one key in a Workers KV namespace. It depends on a `KVNamespace`, as `dependencies: { namespace }`.

  - `Key` is required, and is 1 to 512 bytes. A change to `Key` writes the new key, then deletes the old key at the end of the deploy. If the new key already exists, the deploy fails and the old key stays as it was.
  - `Value` is a string, and is stored as it is. To store JSON, pass `JSON.stringify(value)`. A change to `Value` writes the key again.
  - Create fails when the key already exists in the namespace, rather than overwrite it. KV is eventually consistent, so a key deleted in the last minute can still read as existing, and a key written elsewhere in the last minute may not be seen. Delete deletes the key.
  - Create waits while the KV calls report that the namespace doesn't exist, for up to about 60 seconds. A namespace that the same deploy created can be missing from them for a few seconds.
  - KV is eventually consistent. After a write, create and update read the key until it returns the written value, for up to about 60 seconds, and fail after that. A later deploy that reads an older value plans an update, which writes the value again.

- 1125cdc: A Worker can bind an R2 bucket, a KV namespace, a JSON value and a secret.

  - `$worker` bindings take an `R2Bucket` resource, a `KVNamespace` resource, a value from `json(value)` and a secret from `workerSecret()`. In `env`, these are an `R2Bucket`, a `KVNamespace`, the JSON value and a `string`. A Worker that binds a bucket or a namespace is uploaded after it.
  - `workerSecret({ id, source, key })` from `@notation/cloudflare/workers` declares a secret that a Worker binds as secret text. A source and a key are required. Deploy reads the value from the source each time it uploads the Worker. State records the source, the key and the source's version, and never the value. A new version from the source uploads the Worker again. For `env` and `dotenv`, that is every deploy.
  - `WorkerScript` takes `r2_bucket` and `json` bindings, and a `SecretBindings` param, which uploads each secret as a `secret_text` binding.

- ce4a9e1: A Worker's secrets are set with Cloudflare's secrets API for the Worker, before its code is uploaded, and `notation secret set` can set them.

  - `workerSecret({ id, source?, key? })` takes an optional source and key. The value comes from the source, or from the prompt when there is no source. `notation secret set` writes a Worker secret to each deployed Worker that binds it, and fails when none is deployed. `notation secret delete` deletes it from each of them.
  - The new `WorkerSecret` resource sets one secret of a Worker with Cloudflare's secrets API for the Worker. A Worker gets one for each Worker secret that it binds. It writes a sourced value when the source's version changes, and a value without a source only when the Worker doesn't have it. It deletes the secret when the Worker stops binding it.
  - The new `WorkerScriptPlaceholder` resource makes sure a Worker exists before its secrets are set. Deploy sets a Worker's secrets before it uploads the Worker's code, so the code never runs without them. A new Worker that binds a Worker secret is first uploaded as a placeholder that answers 503 and has the tag `notation-placeholder`. Then deploy sets its secrets, and then uploads its code, which removes the tag. A live Worker that gains its first secret keeps its name, and gets no placeholder upload. The placeholder refuses a Worker that exists without the tag, unless it is the Worker in state.
  - A deploy that stops at a secret without a source, such as in CI with no terminal, leaves only the placeholder live. `notation secret set` writes the value to the placeholder, and the next deploy uploads the code.
  - Destroy deletes a Worker first, which deletes its secrets with it, and then the placeholder if it still has the tag. If the Worker's delete fails, destroy stops there.
  - `WorkerScript` takes `ScriptName` in config, for a Worker created with the name of its placeholder. The name in its state record wins. Its create uploads over a Worker with the placeholder tag.
  - `WorkerScript` no longer takes the `SecretBindings` param, and no longer uploads secrets as `secret_text` bindings. Each upload keeps the Worker's `secret_text` bindings, so an upload never needs a secret's value. This also keeps a secret set with `wrangler secret put`, which an upload deleted before.

### Patch Changes

- Updated dependencies [c290823]
- Updated dependencies [ce4a9e1]
  - @notation/resource@0.21.0
  - @notation/core@0.21.0
  - @notation/std@0.21.0
  - @notation/utils@0.21.0

## 0.20.0

### Minor Changes

- b94c07e: The `cloudflare/tokens/AccountToken` resource has the params `Condition`, `ExpiresOn` and `NotBefore`. `Condition` holds the client IP ranges that may or may not use the token, and the times are ISO 8601 times in UTC. A change to any of them updates the token in place, and the token keeps its value. If the IP ranges are changed in the dashboard, deploy changes them back.

  `accountToken()` from `@notation/cloudflare/tokens` has the option `condition`. It has no option for an expiry time, because the token isn't rotated when it expires.

- dcfd909: `@notation/cloudflare/resources` exports two resources for Cloudflare Containers.

  - `cloudflare/containers/ContainerApplication` runs the containers of a Durable Object namespace. A change to `Configuration` starts a rollout that replaces the instances 25% at a time. The application depends on the `WorkerScript` that hosts the namespace, and `HostedNamespaceId` picks the namespace from the Worker's `DurableObjectNamespaces`. The Worker is deployed first. The create then looks up the namespace's ID in the namespaces that Cloudflare lists for the Worker, and tries again until the namespace is listed. Cloudflare sometimes reports a new application as not found for a second or two, so the create reads the application every 250 ms until Cloudflare finds it, for up to 15 seconds. A replaced Worker gets new namespaces, so deploy deletes the application first and creates it again after the Worker. Cloudflare merges a rollout's configuration with the current one, so for each key that is removed from `Configuration`, the rollout sends the value that a create without the key gives: no environment variables, the default network, the resources of the `lite` instance type, and a 2000 MB disk next to `vcpu` and `memory_mib`. `Configuration` takes `disk: { size_mb }`, which sets the disk size next to `vcpu` and `memory_mib`. The plan rejects `disk` next to an instance type, because an instance type sets its own disk size. It also rejects a disk size below 512 MB, which Cloudflare refuses. Cloudflare can't change an application's network mode, so the plan rejects a change to it. The read doesn't return the configuration. The application uses Cloudflare's `default` scheduling policy, under which the image is set on the application. The application name can't contain two consecutive dashes, start with a dash or a digit, or end with a dash, and the plan rejects such a name. A deploy soon after another may fail while the earlier rollout is still running.
  - `cloudflare/workers/WorkerScript` takes `container: true` on an entry of `DurableObjectNamespaces`, which declares the class as a container class in the upload. The upload sends it as `containers: [{ class_name }]`.
  - `cloudflare/containers/ContainerRegistry` gives Containers the credentials to pull images from a private registry. A change to the credentials replaces the registry.

  For now, containers can only be used through `@notation/cloudflare/resources`. The Durable Object namespaces that `$worker` and `$durableObject` declare never set `container`, so a `ContainerApplication` can't use them.

  The API token in `CLOUDFLARE_API_TOKEN` also needs the Containers permission.

- 0f3319f: `@notation/cloudflare/resources` exports the resource `cloudflare/kv/KVNamespace`, which makes a Workers KV namespace. `WorkerScript` takes a `kv_namespace` binding, which binds a namespace by its ID. Both are at the resource level only: `$worker` can't bind a namespace yet.

  - `Title` is required, and must be unique in the account. A change to `Title` renames the namespace. Create fails when the account already has a namespace with the title.
  - `Jurisdiction` is optional, and is one of `eu`, `fedramp` or `us`. Cloudflare sets it only when it creates the namespace, so plan fails when it changes.
  - The API token also needs the Workers KV Storage: Edit permission.

- 2da0583: `@notation/cloudflare/resources` exports the resource `cloudflare/r2/R2Bucket`, which creates an R2 bucket. A Worker can't bind a bucket yet.

  - Its key is the account, `BucketName` and `Jurisdiction`. Every request sends the `cf-r2-jurisdiction` header. Plan fails when the account, the name or the jurisdiction changes, because a replace would delete the old bucket first.
  - `StorageClass` is required, and a change to it is applied in place. `LocationHint` is only used when the bucket is created.
  - Create fails when a bucket with the name already exists. Delete fails with a clear message when the bucket still has objects.
  - The API token also needs the Workers R2 Storage: Edit permission.

- a9e3fe4: Secrets for Workers, part 1 of RFC 0017. Notation records where a secret is, and never its value.

  - `secret({ id, name })` from `@notation/cloudflare/secrets-store` declares a secret in the account's Secrets Store. Its name is `<app>--<stage>--<id>`, or `name` when it is set. Deploy writes its value from a source or a prompt; see the entry for part 2. Destroy deletes a secret with a stage-scoped name, and leaves a secret with an explicit `name`.
  - `accountToken({ id, policies })` from `@notation/cloudflare/tokens` declares an account-owned API token. Each policy names its permission groups as Cloudflare lists them, such as `Workers Scripts Write`. Plan looks up each group's ID, and the scope of the policy's resources picks the group of a name that has one group for each scope. When the token is created, its value is written to a secret with the token's name, `<app>--<stage>--<id>`, in the same step. A change to the policies updates the token, which keeps its value. If the secret is deleted, plan fails and says to rotate the token by changing its `id`. Destroy deletes the token and its secret. `CLOUDFLARE_API_TOKEN` needs the Account API Tokens: Edit permission.
  - `secretsStore.bind(secret)` from `@notation/cloudflare/workers` binds a secret or a token to a Worker as a `secrets_store_secret` binding. In the Worker, `env.NAME` is a `SecretsStoreSecret`, read with `await env.NAME.get()`. The Worker is uploaded after the secret.
  - Notation adds the account's Secrets Store as the resource `secrets-store`. It adopts the store if the account has one, and otherwise creates one named `default_secrets_store`. Destroy leaves the store. `CLOUDFLARE_API_TOKEN` needs the Secrets Store: Edit permission.
  - `@notation/cloudflare/resources` exports the resources `cloudflare/secrets-store/SecretsStore`, `cloudflare/secrets-store/SecretsStoreSecret` and `cloudflare/tokens/AccountToken`.

- a9e3fe4: Secrets take their values from sources, part 2 of RFC 0017. Notation writes a secret's value to its store, and never records the value.

  - `secret({ id, source, key })` from `@notation/cloudflare/secrets-store` takes its value from a source. `@notation/std/sources` exports `env`, which reads `process.env`, and `dotenv(path)`, which reads a `.env` file relative to the project root. `source` and `key` are given together. Each secret with a source has a `SourceValue` resource, `value:<id>`, which records the secret's id, the source's name, the key and a version. `env` and `dotenv` have no versions, so their secrets are written on every deploy. A source's `version` may return `undefined` for one key, which is then written on every deploy too. Plan and deploy fail when the source doesn't have the key.
  - A secret without a source takes its value from a hidden prompt, when deploy creates it. With no terminal, or with `--json`, deploy fails with the command that sets the secret. `notation watch` asks at each deploy that needs the value. Plan never asks, and notes that deploy will. A secret without a source that already exists is recorded without asking.
  - `notation secret set <id>` writes a secret's value, read from a hidden prompt or from stdin. `notation secret delete <id>` deletes a secret, and needs `--yes` without a terminal. Both refuse an API token's secret.
  - `SecretsStoreSecret` now requires `ValueFrom`, and its create and update write the value.
  - `Redacted` from `@notation/core` holds a secret value. Turning it into a string or JSON throws, and `console.log` prints `Redacted(<hidden>)`. A source implements the `Source` interface from `@notation/std/sources`, and a resource reads a value with `getValue(id)`.
  - The reconciler removes every secret value that the process read from the errors of operations before it records them, and the CLI removes them from the error that it prints when a command fails.

### Patch Changes

- 5f2bde9: A rate-limited Cloudflare request now throws a pending error marked as throttled, so a create lookup that is rate-limited runs again later instead of counting as finding the resource.
- Updated dependencies [aa8eea2]
- Updated dependencies [a9e3fe4]
  - @notation/resource@0.20.0
  - @notation/core@0.20.0
  - @notation/std@0.20.0
  - @notation/utils@0.20.0

## 0.19.0

### Minor Changes

- e41a52e: Deploy now generates the name of a Cloudflare Worker, as it does for AWS names (RFC 0018).

  - **Breaking:** `$worker` no longer takes a `name` option. Code that passes it no longer type-checks.
  - A Worker that deploy creates is named `<app>--<stage>--<id>-<instance>`, with 8 random hex characters as the instance, such as `shop--prod--orders-3f9a1c2e`. Before, it was named `<app>--<stage>--<id>`, or `<app>--<stage>--<name>`. A name that is too long is cut before the instance.
  - The longest name is 54 characters, not 63. A Worker's name is the first label of its workers.dev URL, and a preview URL puts an 8 character version prefix and a hyphen in the same label.
  - Plan shows the name of a Worker that deploy creates as unknown, and so its workers.dev URL, a Durable Object binding to a namespace that it hosts, and a service binding to it.
  - `WorkerScript`'s `ScriptName` has a `physicalName` rule, so config can't set it. A Durable Object binding to a namespace on another Worker, and `BoundDurableObjects[].scriptName`, read the host's name through an output ref. A Worker that binds itself as a service refers to its own name, and is created once with the binding. The binding is now a contribution, as for a service binding to another Worker, so it comes after the bindings in config. A Worker that binds itself is updated once on the next deploy when this changes the order of its bindings.
  - `DurableObjectTransferSources` now holds one entry for each hosted namespace and each other Worker that binds it: the namespace id, the Worker's `$worker` id, its name from its state record, and the start of the name that deploy generates for it. The host reads the names of those Workers from state, with no dependency on them. The param is hidden and not compared, so the change of shape does not update a Worker.
  - When a namespace is new to a Worker, and a Worker that binds it has no state record, deploy fails if a Worker in the account with a name that deploy gives that Worker hosts the namespace's class. Such a Worker may be the old host, with its record lost. Without the check, the new host would start an empty namespace while the old Worker keeps the objects. The check matches a generated name, cut as deploy cuts it. It can fail a deploy that is correct, for a Worker whose id ends in something that looks like an instance.
  - `$worker` no longer checks that no two Workers get the same name.
  - **Breaking:** `WorkerGroupConfig` in `@notation/cloudflare/workers` no longer has `scriptName` or `transferSources`.

### Patch Changes

- 19036ae: Deploy needs one new IAM permission, `logs:DescribeLogGroups`, for the log group's read. An authorizer is now looked up with `GetAuthorizers`, which needs `apigateway:GET` on the API's authorizers. A deploy that changes a log group's `kmsKeyId` or `tags` also needs `logs:AssociateKmsKey` or `logs:DisassociateKmsKey`, and `logs:ListTagsForResource`, `logs:TagResource` and `logs:UntagResource`.

  A deploy now takes over a resource that already exists, instead of failing. This recovers a resource that an earlier deploy created but did not record.

  - When a resource's `create` reports that the resource already exists, deploy takes the resource over, for every resource class. It reads the resource, records it with the params that the read returned, and then updates, replaces or keeps it. Every AWS name that Notation makes starts with `<app>--<stage>--`, so a resource with the same key belongs to the same deployment. Deploy does not check who made the resource. Deploy output prints `Took over <id>: it already existed, so deploy read it and now compares it with config` for each takeover.
  - `@notation/resource` adds `ResourceAlreadyExistsError`. A `create` handler throws it when the provider refuses the create because the resource already exists. A provider package should start each resource's name with the app and the stage, with `physicalName` on the name's schema item or with `scopedPhysicalName`, because deploy takes over any resource with the same key.
  - Deploy writes a state record with `lastOperation: "creating"` before it calls a resource's `create`, and replaces it when the create is done. Plan and deploy decide **create** for a resource with a `creating` record, and its dependents plan against unknown outputs. `notation plan` prints `recovers a create that an earlier deploy did not finish` under such a create.
  - `find` now takes only `params`, and `create` no longer receives a token. `find` returns the key of the one resource that a create with those params makes, throws `ResourceNotFoundError` when there is none, and must fail when several match. Deploy calls `find` before every `create` of a class that has `find`, and takes over what it finds. A resource whose key the provider assigns, such as an API Gateway API, is then not made a second time.
  - When the lookup of a create with an unknown outcome finds the resource, deploy takes it over too, and puts what is missing, such as a log group's retention, in the same deploy.
  - After a takeover, deploy updates each param that the resource's `read` does not return, because it cannot tell whether the param matches config. A param whose difference would replace the resource is assumed to match.
  - The create of a replacement does not take over a resource that has the key of the resource it replaces. A replacement with a generated name has a new name, so this applies to a resource whose key stays the same, such as a Cloudflare Worker. This holds when `find` returns the resource before the create, when the provider reports that the resource exists, and when the lookup of a create with an unknown outcome finds it. Deploy fails, and writes the record of the replaced resource back, so the next deploy replaces it again. The rule does not cover a dependent that the replace deleted because it blocks the delete, which deploy creates again later in the same deploy.
  - Deploy fails the create instead of taking a resource over when the provider assigns the resource's key and its class has no `find`, when `find` finds no resource or several, or when the class has no `read`.
  - When create fails and its outcome is not classified as unknown, deploy writes back the record that it started from, or removes the `creating` record when it started from none. This includes a create that the provider refused because the resource exists, when deploy cannot take the resource over. The create of a replacement then writes back the record of the replaced resource.
  - The orphan sweep and destroy delete the resource of a `creating` record by the key that `find` returns or that the record holds. When `find` finds no resource, or no key is known, they remove only the record, and emit a `skip` event with the reason `not-created` or `key-unknown`.
  - When the `creating` record names another key than config, the resource that the unfinished create may have made under the old key is left in the provider. A class with a key that the provider assigns and no `find`, such as API Gateway's `LambdaIntegration`, is created a second time when a create stops before deploy records it.
  - `awsCreate` in `@notation/aws/resources` takes an `alreadyExists` option. API Gateway's `RouteAuth` and `LambdaIntegration` now wrap their `create` in `awsCreate`, so a `CreateAuthorizer` or `CreateIntegration` call that times out or gets a server error has an unknown outcome, and the `creating` record stays. `LambdaIamRole`, `LambdaFunction`, `LambdaPermission`, `LambdaLogGroup`, `LambdaEventSourceMapping`, `eventBridge.EventBus`, `eventBridge.Rule`, `sqs.Queue`, and API Gateway's `Stage` and `Route` report an existing resource as `ResourceAlreadyExistsError`, as does Cloudflare's `WorkerScript`. A Worker with the same name that already exists in the account is now taken over.
  - API Gateway's `Api` and `RouteAuth` are found by name, `Route` by its route key, `sqs.Queue` by its name, and `LambdaEventSourceMapping` by its function and event source. `LambdaEventSourceMapping`'s `find` leaves out a mapping that is being deleted. `Api`, `LambdaFunction`, `LambdaEventSourceMapping` and `sqs.Queue` are no longer tagged with `notation:create-token` when they are created. A resource that an earlier version created keeps the tag, and deploy does not remove it. The read of an `Api` leaves the tag out of `Tags`, so the tag does not replace the API. `LambdaEventSourceMapping` supports one mapping per function and event source.
  - `LambdaLogGroup` gains a `read`, so deploy takes over a log group with the function's log group name. This covers the log group that Lambda makes when a function first logs, and one that a deleted function left. Its update now sets each changed param with its own API call. Before, a change to `kmsKeyId` or `tags` was sent to `PutRetentionPolicy`.
  - `LambdaLogGroup` reports a failure to set its retention policy, after the log group was made, as `ResourceCreationUnknownError`. The EventBridge rule and `sqs.Queue` check that no resource with the name exists before they create it. When the rule's targets can't be put during create, it deletes the rule, and reports a failed delete as `ResourceCreationUnknownError`. `LambdaRolePolicyAttachment` treats a detached policy as deleted.

  Deploy now generates the AWS names of functions, roles, queues, rules, schedules, event buses and APIs, and config cannot set them.

  - **Breaking:** `lambda()`, `$lambda`, `queue()`, `api()`, `eventBus()`, `rule()`, `schedule()` and `eventBridge.bind(bus).defineRule()` no longer take a `name` option. A resource class carries all of the provider's fields, including the name field, but the reconciler generates the name from the resource ID. There is no override for now. If an exact name is needed later, an override will be added then. `jwtAuthorizer()` keeps its `name`, which is unique only within its API, and a Cloudflare Worker keeps its name.
  - A declaration gets a generated name: `<app>--<stage>--<base>-<instance>`. The base is the resource's state key without its type prefix, in lower case, with each run of characters other than `a-z` and `0-9` turned into one `-`. The instance is 8 random hex characters. For example, `$lambda({ id: "todos" })` is named `my-app--prod--todos-1a2b3c4d`, and its role `my-app--prod--todos-role-5e6f7a8b`. Before, they were named `my-app--prod--todos` and `my-app--prod--todos-role`.
  - Deploy generates Lambda's `FunctionName`, the Lambda role's `RoleName`, SQS's `QueueName`, the `Name` of an EventBridge rule, schedule and event bus, and the `Name` of an API Gateway API. A FIFO queue's generated name ends in `.fifo`. A Cloudflare Worker's name does not change.
  - Deploy generates the name when it first creates the resource, and keeps it in state. Later deploys read the name from state. Deploy writes the name in the `creating` record before it calls the provider, so a deploy that stops during the create finds the resource again under the same name.
  - **A resource that is already in state keeps its name.** An upgrade renames nothing. A resource gets a generated name when deploy next replaces it.
  - A replace still deletes the resource first. The replacement of a resource with a generated name gets a new name. So the replacement of such a queue does not wait for SQS to release the old name.
  - A resource that an earlier version named from its `name` keeps that name when you remove `name`, until deploy next replaces it.
  - `notation plan --json` shows a generated name as `{ "$unknown": "after-apply" }` until the resource exists, and for a resource that deploy replaces. A param that takes the name, such as a role policy's `RoleName` or a rule's `EventBusName`, is unknown until then too. The plan of a replace does not list the name among the changed fields.
  - The infra code can't read a generated name. Read it through an output ref, such as `ordersBus.name`.
  - The constructs no longer check that no two declarations get the same AWS name, because a generated name has its own instance. Two Lambda functions whose ids differ only in case, such as `myFn` and `myfn`, are allowed.
  - A generated name that is too long is cut before the instance. With a long app name and a long stage name, the cut removes the whole id, and such names differ only in the instance.
  - `@notation/resource`: a param's schema item takes `physicalName: PhysicalNameRule`, which has `maxLength` and two new fields. `ending` is a function that takes the resource's params and returns the ending of a generated name, such as `.fifo`. `ending` replaces `requiredEnding`, which is removed, and `physicalName` and `scopedPhysicalName` no longer keep an ending when they shorten a name. `base` is a function that maps the resource ID to the base of a generated name, and without it the base is the whole resource ID. The config type leaves out a param with `physicalName`, and plan and deploy throw when `deriveParams` or untyped config supplies it. Deploy always generates it. `generatedPhysicalName` makes the name. A dependent reads the name through an output ref, because config does not hold it. `scopedPhysicalName` stays the tool for a fixed name on a class without `physicalName`, such as a Cloudflare Worker's.
  - **Breaking:** `deploy` in `@notation/reconciler/durable` takes a required `nameScope: { app, stage }`. `deployApp` in `@notation/core` passes the deployment's app and stage.

  Generated names have these limits:

  - A generated name is only in state. If the state record of a resource with a generated name is lost, other than by a deploy that stopped during the create, the next deploy creates a second resource with a new name, and the first stays in AWS.
  - If the create of a queue ends with an unknown outcome and you then turn `fifo` on, state keeps a name without `.fifo`, and deploy fails until you turn `fifo` off again.

- e41a52e: Cloudflare sometimes reports a Worker as not found for about a second after the upload that created it, which failed the deploy. `WorkerScript`'s create now reads the Worker after the upload, and reads it again every 250 ms until Cloudflare finds it. If Cloudflare still reports the Worker as not found 15 seconds after the upload, the create fails.
- Updated dependencies [3628aa5]
- Updated dependencies [19036ae]
- Updated dependencies [e41a52e]
  - @notation/resource@0.19.0
  - @notation/core@0.19.0
  - @notation/std@0.19.0

## 0.18.0

### Minor Changes

- 968e03d: A Durable Object namespace is deleted only when it is unprotected in state. Plan and deploy fail, before deploy changes anything, for a change that would delete a protected namespace.

  - `$durableObject({ id, class, protect })` takes `protect`, which defaults to `true`. Plan reads it from the state of the hosting Worker. To delete a namespace, deploy `protect: false` first, which updates the Worker. A later deploy can remove the declaration, remove the Worker, or change the Worker's `id` or `name`.
  - Plan fails when a Worker no longer hosts a protected namespace that it hosted. This covers a removed declaration, and a changed `id`, with or without a changed `class`. Before, deploy deleted the namespace.
  - Deploy moves a namespace, with its objects, when its class export moves to another Worker and the old host still binds the namespace. The new host's upload moves it, using Cloudflare's `expecting-transfer` and `transferred` exports entries. Plan fails when the old host no longer binds a protected namespace whose class moved, when the move also changes the class, and when the new host gets a namespace that another Worker binds in the deploy that renames or deletes another of its namespaces. Deploy fails before any upload when the new host is created in the same deploy, which plan doesn't catch, and when the old host hosts a namespace that Cloudflare doesn't list as SQLite. Before, deploy deleted the namespace on the old host, and the new host got a new, empty namespace.
  - Plan fails when a Worker that hosts protected namespaces is removed or replaced, as when its `id` or `name` changes. Before, deploy deleted the Worker with its namespaces.
  - The check that a namespace doesn't take another namespace's class runs at plan, not during the Worker's upload.
  - `defineOperations` takes `rejectChange(previous, desired, { replace })`. It returns a message to fail plan and deploy with. The resource class and its instances expose it. Plan and deploy call it for each resource that has a state record, and for each orphan that the orphan sweep deletes, with `desired` undefined. `replace` is true when deploy deletes the resource and creates it again, also when a replaced dependency's delete needs it deleted first. `notation destroy` doesn't call it.
  - Deploy now fails with a param's `rejectReplace` message before it changes any resource, when the param's value is known before deploy. Before, deploy failed just before the resource's operation.

### Patch Changes

- Updated dependencies [968e03d]
  - @notation/resource@0.18.0
  - @notation/core@0.18.0
  - @notation/std@0.18.0

## 0.17.0

### Minor Changes

- f490162: New package. `@notation/cloudflare/workers` declares Cloudflare Workers and Durable Object namespaces, in runtime modules, as RFC 0015 describes.

  - `$worker({ id, bindings, compatibilityDate, compatibilityFlags, url })` declares the Worker that its module deploys as. The module has a default export. `bindings` binds a namespace from `$durableObject` as a Durable Object namespace, another Worker as a service binding, and a string as plain text. `WorkerEnv<typeof worker>` and `WorkerHandler<typeof worker>` type `env` and the default export. The Worker is named `<app>--<stage>--<id>`, and is served on workers.dev unless `url` is `false`. `compatibilityDate` is required. `nodejs_compat` is always added to the compatibility flags.
  - `$durableObject({ id, class })` declares a namespace. The Worker that binds the namespace and exports its class hosts it. Other Workers that bind it bind it on that Worker, and are uploaded after it. Plan fails, naming the Worker's module, when no Worker that binds the namespace exports the class, or when two do.
  - The user exports the class from the Worker's module, under its own name. Deploy doesn't add the export.
  - A new namespace uses SQLite storage. Deploy uploads Cloudflare's declarative `exports` map. A namespace whose class changes, with the same `id`, is renamed and keeps its objects. A namespace whose declaration is removed is deleted, with its objects.
  - `@notation/cloudflare/resources` exports the resources `cloudflare/workers/WorkerScript`, which uploads a Worker with its bindings and namespaces, and `cloudflare/workers/WorkerSubdomain`, which serves it on workers.dev. They read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account is stored in state. Plan and deploy fail when `CLOUDFLARE_ACCOUNT_ID` differs from the account in state.

- 614ce3f: Deploy resources that depend on each other through contributions, as RFC 0011 describes. Before, plan and deploy failed on any dependency cycle.

  - In each loop, deploy picks a placeholder: a member that depends on the others only through its contributions, whose params that those contributions set are optional and don't force a replacement, and whose type has `update`. Deploy creates it without the contributions that refer to the other members, creates the other members, and then updates it with its full params. With drift detection, a placeholder that no longer exists is created again in the first pass. A dry run stops after the first pass, and then reports the decision for each placeholder that has a record.
  - Deploy then applies every member again until no output changes, for at most one pass per member, and at least two. If an output still changes, deploy fails with `ResourceCycleError`, naming the outputs that changed. When no member of a loop can be the placeholder, plan and deploy fail with `ResourceCycleError`, which says why for each member.
  - Deploy replaces a member of a cycle as it replaces any resource, and destroy deletes the members of a cycle in the reverse of their order in deploy. In both, a member is deleted while another member still refers to it, and the orphan sweep does the same for orphans that refer to each other. Each replace of a member adds a pass. A replaced member is created without its contributions that refer to itself, or to a member that the replacement deleted because it blocks the delete, and a later pass updates it. A placeholder's record leaves out the edges to the members it was created without.
  - A type can set `deleteTakesDependents`. Its `delete` then gets a fourth argument, `{ dependents }`: the resources whose state records depend on the deleted resource, which deploy updates or deletes in the same run. A provider that refuses to delete a resource that others refer to can force the delete when every reference comes from a dependent. Exports `ResourceDeletion` from `@notation/resource`.
  - The removal of the record of a dependent that blocks the delete of a replaced resource has the state write key `state:delete:<id>:replace:<replaced id>`, so that two replacements in one deploy can each delete the same dependent.
  - Plan nodes have `cycle` and `placeholder`. Plan plans a member that comes before a replaced member again, so that it shows the update that deploy makes, and `notation plan` prints a line for a placeholder. Plan nodes have `brokenDependents` for a replaced resource whose type sets `deleteTakesDependents`: the declared resources whose records depend on it and that deploy does not delete first. `notation plan` prints them, as their references to the resource are broken from the delete until deploy updates them.
  - Resources have `getFixedDependencies()` and `getContributedParams({ from })`, and `getParams({ excludeContributionsFrom })` returns the params without the contributions that depend on the given resources. Exports `changedKeys` and `forcesReplacement` from `@notation/resource`.
  - `@notation/cloudflare`: a Worker's service binding to another Worker is a contribution to its script's `Bindings`, which is now a collected param. Two Workers can bind each other as services. Cloudflare refuses to delete a Worker that another Worker binds as a service, or whose Durable Object namespace another Worker binds. `WorkerScript` now forces that delete when every Worker that refers to it is a dependent in the deployment, and fails with an error that names the other Workers when one is not. So a Worker that other Workers of the app bind can be renamed, and two Workers that bind each other can be destroyed or removed from code. Workers that each bind a namespace that the other hosts still fail plan. The service bindings now come after the bindings in config, so a Worker whose service bindings came before other bindings is updated once on the next deploy.

### Patch Changes

- 57460fa: - A `WorkerScript` read or delete treats the Worker as not found only when Cloudflare returns error code 10007. Any other 404 fails with the API error, so a delete no longer drops a Worker from state while it still runs.
  - A `WorkerSubdomain` read on an account with no workers.dev subdomain (code 10007) fails with a message that says how to set one up. Any other 404 still fails with the API error.
- Updated dependencies [ae3d823]
- Updated dependencies [614ce3f]
- Updated dependencies [ce76cd5]
- Updated dependencies [ce76cd5]
- Updated dependencies [d93d65a]
- Updated dependencies [d00b769]
- Updated dependencies [9d669fc]
- Updated dependencies [35206ce]
- Updated dependencies [8839f28]
- Updated dependencies [f490162]
- Updated dependencies [e9da750]
- Updated dependencies [e4f4157]
- Updated dependencies [f490162]
- Updated dependencies [7eb8766]
- Updated dependencies [1cce9df]
- Updated dependencies [ce76cd5]
- Updated dependencies [3fefade]
- Updated dependencies [ce76cd5]
- Updated dependencies [121442b]
- Updated dependencies [4776f9f]
- Updated dependencies [6cec012]
- Updated dependencies [f490162]
  - @notation/core@0.17.0
  - @notation/resource@0.17.0
  - @notation/std@0.17.0
