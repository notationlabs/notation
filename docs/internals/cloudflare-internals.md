# Cloudflare Internals

`@notation/cloudflare` manages Workers, Durable Objects, KV, R2, Containers, Secrets Store, and Account Tokens over Cloudflare's REST v4 API (`https://api.cloudflare.com/client/v4`). It handles eventual consistency, gradual rollouts, Durable Object namespace transfers, and rate limits.

## API client

All REST calls flow through `cloudflare()` and `cloudflareGetText()` in `packages/cloudflare/src/api/client.ts`.

### Timeout handling

Requests enforce `REQUEST_TIMEOUT_MS = 120_000` (120 seconds, sized for maximum Worker uploads) via `AbortSignal.timeout`. Inside the `try` block, the client reads `response.arrayBuffer()` and decodes it with `new TextDecoder("utf-8", { ignoreBOM: true })`. This prevents `Response.text()` from stripping a leading `U+FEFF` from KV values. Timeouts and `TypeError` network errors throw `CloudflareNetworkError`.

### Rate limits

Cloudflare signals rate limits with HTTP `429`, or with a non-429 status (including `200` with `success: false`) carrying error code `971` (`THROTTLED`) or a matching throttle message. `checkResponse` translates those responses into `ResourceOperationPendingError` with `throttled: true`. It parses `retryAfterMs` from `Retry-After`, defaulting to `5_000` ms.

### Creation error classification

`cloudflareCreate` wraps `create` handlers to convert `CloudflareApiError` (`status >= 500`) or `CloudflareNetworkError` into `ResourceCreationUnknownError`. [Recovery](./recovery.md) then reconciles uncertain creates instead of duplicating resources.

### Account key tracking

Every Cloudflare resource declares `AccountId` as an `immutable: true`, `secondaryKey: true` parameter derived from `process.env.CLOUDFLARE_ACCOUNT_ID` via `accountId()`: `WorkerScript`, `WorkerSubdomain`, `KVNamespace`, `KVValue`, `KVJsonValue`, `R2Bucket`, `ContainerImage`, `ContainerApplication`, `ContainerRegistry`, `SecretsStore`, `SecretsStoreSecret`, and `AccountToken`.

Storing `AccountId` in state ensures updates and deletes target the owning account. `rejectReplace` guards on `WorkerScript`, `KVNamespace`, and `R2Bucket` block accidental account moves.

## Workers

### Declaration marks

`$worker` (`packages/cloudflare/src/workers/worker.ts`) carries `@declaration shared: id, bindings; runtime: entrypoint; entryOption: entrypoint; keys: bindings; entry: default; platform: workerd; outputs: url`. `worker()` and `addBindings()` carry `@resource` and throw at runtime. In `packages/cloudflare/src/workers/runtime.ts`, `$worker` defines a non-enumerable `url` getter that throws if Worker code reads `url` directly (see [Transforms](./transforms.md)).

### Entry export inspection

For `worker()` declarations with `code.type === "file"`, `readEntryExports(file, source, "workerd")` (`packages/build/src/exports.ts`) parses the prebuilt file statically. It extracts exported value names (`names`, `stars`) and rejects exports incompatible with `workerd`. Bundle inputs read precomputed `code.exports` instead.

### Secret uploads

`putScript` (`packages/cloudflare/src/api/workers.ts`) uploads multipart `FormData` with `metadata` JSON and the main module `File` (`application/javascript+module`), setting `keep_bindings: ["secret_text"]` to preserve omitted secrets:

```ts [packages/cloudflare/src/api/workers.ts]
const metadata = {
  main_module: upload.mainModule,
  compatibility_date: upload.compatibilityDate,
  compatibility_flags: upload.compatibilityFlags,
  bindings: upload.bindings,
  keep_bindings: ["secret_text"],
  ...(Object.keys(upload.exports).length > 0 ? { exports: upload.exports } : {}),
  ...(upload.containers.length > 0 ? { containers: upload.containers } : {}),
};
```

`WorkerScript` (`packages/cloudflare/src/resources/workers/worker-script.ts`) synchronizes secrets incrementally:

| Phase | Behavior |
| :--- | :--- |
| Initial upload | `WorkerScript.create` sends all `Secrets` |
| Incremental update | `WorkerScript.update` sends only changed `secret_text` bindings |
| Removal | Secrets absent from `Secrets` and `Bindings` are deleted via `deleteScriptSecret` |
| Propagation polling | `waitUntilSecretsListed` polls `GET .../secrets` every `250` ms up to `15_000` ms |

During incremental updates, the reconciler passes `undefined` for unchanged credential versions. `waitUntilSecretsListed` treats `WORKER_NOT_FOUND = 10007` as empty while a new script propagates.

### Placeholder uploads

Service bindings (`{ type: "service", name, service: bound.script.outputRef("ScriptName") }`) and `OutputRef`/`Derived` `plain_text` bindings (including a Worker's own `url` or mutual `url` bindings) attach via `script.contribute({ Bindings: [...] })` rather than direct `config`.

Because `WorkerScript.Bindings` is optional and mutable, the cycle breaker ([Planner](./planner.md), [Durable Execution](./durable-execution.md)) resolves mutual binding cycles in three steps. It uploads one Worker first as a placeholder without peer-dependent `Bindings`, uploads the peer, and finally updates the placeholder with the resolved `ScriptName` or `Url`.

### Eventual consistency

Both `WorkerScript` and `WorkerSubdomain` set `readLagsCreate: true`. `getScriptSettings` treats HTTP `404` matching `/has no versions/i` as `{}` before checking `WORKER_NOT_FOUND = 10007`.

### Dependent deletion

`WorkerScript` sets `deleteTakesDependents: true`. When `deleteScript` fails with `isReferenced` (`10142` or `10064`), `deleteReferencedScript` queries `getScriptReferences` (`GET .../references` and `GET .../workers/tails/by-consumer/<scriptName>`). It verifies that no external Worker or Pages project references the script outside `deletion.dependents`, then retries `DELETE` with `?force=true`.

### Gradual rollouts

`WorkerScript.update` calls `assertNoRollout` (`GET .../deployments`) and aborts if two or more versions serve traffic (`percentage > 0`). Uploading a new script routes 100% of traffic to it and cancels the active rollout.

`WORKER_NAME_MAX_LENGTH = 54` (`workerNameRule` in `packages/cloudflare/src/id.ts`) reserves space for Cloudflare's 8-character preview prefix and hyphen inside a 63-character DNS label.

## Durable Objects

### Namespace stubs

`$durableObject` (`packages/cloudflare/src/workers/durable-object.ts`) carries `@declaration shared: id; runtime: class`. In runtime bundles (`packages/cloudflare/src/workers/runtime.ts`), it returns `{ id: config.id }`. In infra builds, `@notation/build` replaces the stripped class reference with a stub function preserving `.name`, so `$durableObject` reads `(config.class as { name?: unknown })?.name`.

### Namespace bindings

`resolveBindings` and `hostOf` (`packages/cloudflare/src/workers/worker.ts`) assign namespace ownership to the single Worker that both binds the `$durableObject` and exports `className`. The host receives `{ type: "durable_object_namespace", name, class_name }` without `script_name`, while all other binding Workers receive `script_name: scriptOf(host).outputRef("ScriptName")`.

`durableObjectExports` (`packages/cloudflare/src/resources/workers/worker-script.ts`) generates the upload `exports` map:

| State | Export entry |
| :--- | :--- |
| Active hosted class | `{ type: "durable-object", storage: "sqlite" }` |
| Renamed class | `{ type: "durable-object", state: "renamed", renamed_to }` |
| Deleted class | `{ type: "durable-object", state: "deleted" }` |
| Transferred out | Omitted when listed in `BoundDurableObjects` |

A class is marked renamed when its `id` stays the same under a new `className`. Transferred-out classes are omitted because the destination host's deploy already transferred them.

`rejectNamespaceLoss` (`rejectChange`) blocks unsafe namespace changes:

| Change | Rejection rule |
| :--- | :--- |
| Protected deletion | Blocks deleting any protected namespace |
| Identity changes | Blocks changing `id` or reusing a previously hosted `className` |
| Combined mutations | Blocks combining a host transfer with a rename or delete in one deploy |

Namespace protection (`protect`) defaults to `true` and is tracked via `UnprotectedDurableObjects`.

### Namespace transfer sequence

A transfer runs when a Worker hosts a namespace (`DurableObjectNamespaces`) previously hosted by another Worker in state (`DurableObjectTransferSources`). Before transferring, `findTransfers` runs three checks:

| Check | Requirement |
| :--- | :--- |
| Destination exists | Destination Worker already exists |
| Source recorded | Source Worker has a state record matching `workerNames(binder.id)` |
| SQLite storage | Every namespace on the source Worker has `use_sqlite === true` |

Checking the source state record prevents silent data loss, and `listAccountNamespaces` queries `GET .../workers/durable_objects/namespaces` (`per_page=1000`, up to `100` pages, excluding `dispatch_namespace` and `preview`) to verify SQLite storage.

`transferNamespaces` then executes Cloudflare's three-step transfer:

1. **Expecting upload** – Calls `putScript` on the destination Worker with `{ type: "durable-object", storage: "sqlite", state: "expecting-transfer", transfer_from }` in `exports`. It filters out self-bindings (`script_name === undefined`) to incoming classes so Cloudflare does not reject bindings to unarrived namespaces.
2. **Source patch** – Calls `patchScriptExports` (`PATCH .../settings` FormData `settings`) on each source Worker. Moved classes get `{ type: "durable-object", state: "transferred", transferred_to }`, while remaining classes keep `{ type: "durable-object", storage: "sqlite" }`.
3. **Final upload** – Calls `putScript` on the destination Worker with all `bindings` restored and `{ type: "durable-object", storage: "sqlite" }` in `exports`.

## KV

### Key replacement

`KVValue` (`packages/cloudflare/src/resources/kv/kv-value.ts`) and `KVJsonValue` (`packages/cloudflare/src/resources/kv/kv-json-value.ts`) share `kvResourceMeta` (`packages/cloudflare/src/resources/kv/kv-operations.ts`). It sets `replaceCreatesFirst: true` so changing `Key`, `NamespaceId`, or `AccountId` writes the new key before deleting the old one.

### Write confirmation polling

`kvOperations` coordinates eventual consistency across `create` and `update`:

| Phase | Behavior |
| :--- | :--- |
| Pre-write check | Calls `getKVValue` when `!context?.Written` before writing via `cloudflareCreate` |
| Propagation retry | Retries code `10013` as `ResourceOperationPendingError` |
| Read-after-write polling | Reads back `getKVValue` until `stored === text` |

The pre-write check avoids overwriting an existing key, and `putKVValue` sends a `Blob` part in `FormData` so `\n` is not normalized to `\r\n`. Both propagation retries (`NAMESPACE_NOT_FOUND = 10013`) and `confirmWrite` (`WRITE_CHECK_INTERVAL_MS = 2_000`, spanning ~60 seconds across the engine's 30-attempt default) set `retryAfterMs: 2_000` and preserve `callbackContext: { Written: true }` so retries skip `PUT`.

### JSON validation

`jsonSchema()` (`packages/cloudflare/src/json.ts`) validates synchronously against strict JSON rules. It rejects non-finite numbers (`NaN`, `Infinity`), `undefined` at any depth, non-plain objects, sparse arrays, arrays with extra keys, `__proto__` keys, and UTF-8 payloads over `25 * 1024 * 1024` bytes as serialized by `sortedJson.encode`.

`KVJsonValue` encodes and decodes with `sortedJson.encode` and `sortedJson.decode`. If `read` encounters corrupt or non-JSON text in KV, `jsonEncoding.decode` returns the raw text (if valid as a JSON string) or `<N characters that are not a valid JSON value>`. This lets `plan` detect drift and repair the key instead of failing schema validation. Because `Value` is a non-hidden `param` returned on `read`, KV values are stored in both `params` and `outputs` in state.

### Namespace protection

`KVNamespace` (`packages/cloudflare/src/resources/kv/kv-namespace.ts`) checks `findNamespaceByTitle` before creating and translates `TITLE_TAKEN = 10014` on rename. It omits `Jurisdiction` from `read` so immutable field differences never trigger replacement, and sets `rejectChange: refuseReplace(...)`.

## R2

### Request headers

Every request in `packages/cloudflare/src/api/r2.ts` sends `"cf-r2-jurisdiction": jurisdiction` (`"default" | "eu" | "us" | "fedramp" | "fedramp-high"`). `setBucketStorageClass` updates `StorageClass` (`"Standard" | "InfrequentAccess"`) via `PATCH` with the `"cf-r2-storage-class"` header.

### Location hint handling

`LocationHint` (`packages/cloudflare/src/resources/r2/r2-bucket.ts`) is marked `hidden: true` and omitted from `R2Bucket.read` because Cloudflare treats it as a creation hint and may place the bucket elsewhere. `R2Bucket.create` checks `getBucket` first, `delete` handles `NO_SUCH_BUCKET = 10006` and `409` `/is not empty/` (`isBucketNotEmpty`), and `rejectChange` uses `refuseReplace`.

When a Worker binds an `R2Bucket`, `r2Binding` (`packages/cloudflare/src/workers/worker.ts`) omits `jurisdiction` for `"default"` and wraps the binding in `all([jurisdiction, bucketName]).map(...)` when `Jurisdiction` is an `OutputRef` or `Derived`.

## Containers

### Image build hashing

`hashBuildInput` (`packages/cloudflare/src/resources/containers/build-context.ts`) computes a length-prefixed SHA-256 over `PLATFORM = "linux/amd64"`, sorted `BuildArgs`, `Dockerfile` bytes, and a sorted recursive walk of `Context`. The walk hashes file bytes, octal permissions, symlink targets, and directory modes while skipping `.git`, normalizing path separators to `/`, and ignoring `.dockerignore`.

`ContainerImage` (`packages/cloudflare/src/resources/containers/container-image.ts`) uses the first `32` hex characters as `Tag` (`TAG_LENGTH = 32`) and marks `Context`, `Dockerfile`, and `BuildArgs` as `hidden: true`.

### Registry operations

- **`create`** – Verifies Docker via `docker info --format {{.ServerVersion}}` and runs `docker build --load --platform linux/amd64 --provenance=false`. It fetches 15-minute `push`/`pull` credentials from `POST .../containers/registries/registry.cloudflare.com/credentials`, authenticates with `docker login --password-stdin`, and pushes the image.
- **`read`** – Requests `pull` credentials and sends `HEAD https://registry.cloudflare.com/v2/<namespace>/<repo>/manifests/<tag>` via `manifestDigest` (`packages/cloudflare/src/api/image-registry.ts`). It uses `Basic` auth (username `v1`, `credentials.password`), a `30_000` ms timeout, and OCI/Docker manifest `Accept` headers, returning `registry.cloudflare.com/<namespace>/<repo>@<digest>` as `Image`. `delete` is a no-op.

### Application rollouts

`ContainerApplication` (`packages/cloudflare/src/resources/containers/container-application.ts`) sets `blocksDeleteOf: [WorkerScript.type]` so replacing a hosting Worker deletes its container application first. `containerApplicationName` (`packages/cloudflare/src/id.ts`) formats names as `<app>-<stage>-<base>-<hash8>` (prefixed with `c-` if starting with a digit) because Cloudflare rejects `--` and leading digits or hyphens.

- **`create`** – Polls `findScriptNamespace` (`retryAfterMs: 5_000` when absent). It retries `400` `"Durable Object namespace was not found"` and code `1607` (`NAMESPACE_NOT_CONTAINER_ENABLED`) with `ResourceOperationPendingError`, and rejects `1608` (`NAMESPACE_HAS_APPLICATION`). After creation, `waitUntilReadable` polls `getApplication` every `250` ms up to `15_000` ms without throwing so `ApplicationId` is always recorded.
- **`update`** – Sends `PATCH` for `MaxInstances` and `POST .../rollouts` with `strategy: "rolling"`, `kind: "full_auto"`, `step_percentage: 25`, and `target_configuration: rolloutTarget(state.Configuration, patch.Configuration)` (`packages/cloudflare/src/api/containers.ts`). `rolloutTarget` explicitly populates cleared keys (`environment_variables: []`, `network: {}`, `instance_type: "lite"`, `vcpu: 0.0625`, `memory_mib: 256`, `disk: { size_mb: 2000 }`) because Cloudflare merges rollout targets with the active configuration.
- **`rejectChange`** – `rejectNetworkModeChange` blocks switching between `"private"` and `"public"` unless `Name` changes to replace the application.

`ContainerRegistry` (`packages/cloudflare/src/resources/containers/container-registry.ts`) checks `findRegistry` before `createRegistry` and re-checks `findRegistry` on `delete` errors because Cloudflare does not return a distinct not-found error code.

## Secrets Store

### Store adoption

`SecretsStore` (`packages/cloudflare/src/resources/secrets-store/secrets-store.ts`) adopts the account's existing store via `listStores` (one per account). If none exists, it creates `DEFAULT_STORE_NAME = "default_secrets_store"` and re-adopts on concurrent creation races. Its `delete` handler is a no-op.

### Secret synchronization

`findSecretByName` (`packages/cloudflare/src/api/secrets-store.ts`) paginates `GET /accounts/<account>/secrets_store/stores/<store>/secrets` (`per_page=100`, `order=name`, `direction=asc`, `search=<name>`). Because `search` performs substring matching against names and comments, it filters for exact `item.name === name && item.status !== "deleted"`.

`createSecret` sends `POST .../secrets` with `[{ name, value, scopes: ["workers"] }]`, while `setSecretValue` uses `PATCH .../secrets/<secretId>` with `{ value }` so scopes and comments are preserved. `writeSecret` checks `findSecretByName` first to choose between `PATCH` and `POST`. `SecretsStoreSecret.delete` looks up the current `SecretId` by name before calling `DELETE`, ignoring `store_not_found` and `secret_not_found` (`INVALID_REQUEST = 1001`).

## Account tokens

### Permission scope resolution

`AccountToken.deriveParams` (`packages/cloudflare/src/resources/tokens/account-token.ts`) normalizes `Policies`, `Condition`, and second-precision UTC timestamps (`toSeconds`), then resolves each permission group name via `GET .../tokens/permission_groups?name=<name>` (`findPermissionGroups`, exact-name filtered).

To disambiguate groups that share a name across scopes, `groupId` extracts scopes from `policy.resources` keys by stripping each trailing `.segment`:

```ts [packages/cloudflare/src/resources/tokens/account-token.ts]
const scopes = Object.entries(resources)
  .flatMap(([key, value]) =>
    typeof value === "object" ? Object.keys(value) : [key],
  )
  .map((key) => key.slice(0, key.lastIndexOf(".")));
```

### Orphan token cleanup

Cloudflare returns a token's `Value` only on `createToken` and `rollToken`. If `create` fails with `ResourceCreationUnknownError`, any token created during that attempt has an unrecoverable value. `AccountToken.find` lists all tokens matching `params.Name` (`TOKENS_PAGE_SIZE = 50`) and deletes every orphan via `deleteToken`. It then throws `ResourceNotFoundError` so the reconciler executes `create` again.

`AccountToken.rotate.Value` calls `rollToken` (`PUT .../tokens/<id>/value`). `read` returns `{}` for an absent `Condition` so externally removed IP filters show as drift. `update` sends `{}` for `condition` and `null` for `expires_on` and `not_before` to clear removed settings.
