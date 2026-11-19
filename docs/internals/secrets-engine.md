# Secrets Engine

Notation keeps plaintext credential values strictly in process memory while storing opaque markers in SQLite state and workflow journals. Registered secret strings are stripped from error messages before any failure is recorded or emitted.

## Credential Markers

A `CredentialMarker` (`packages/resource/src/credential.ts`) stands in for a secret value inside persisted `params`, `output`, and step results:

```ts [packages/resource/src/credential.ts]
export type CredentialMarker = {
  $credential: { resource: string; name: string; version: string | null };
};
```

Each marker identifies the producing `resource`, the credential property `name`, and an opaque `version`. When a producer creates, rotates, or receives `--credential`, its marker gets a new `version` so consumer `params` diffs trigger updates.

When a takeover or read lacks a marker, `addCredentialMarkers` inserts a `null` version. This signals that Notation holds no value and must mint or load one before a consumer can use it.

`omitCredentials` strips a resource's own credential fields, and `getOperationState` replaces taken credential markers with `undefined` before `update`, `delete`, or `rotate`. `assertNoHiddenCredential` rejects any `hidden: true` param referencing a `CredentialRef` because hidden params are omitted from state and would trigger rotation on every deploy.

## In-Memory Credential Tracking

`packages/reconciler/src/credentials.ts` maintains three process-local structures that never leave memory:

| Structure | Role |
| :--- | :--- |
| `held` | Maps each credential `version` to its plaintext value |
| `given` | Records credential versions injected into consumer operations |
| `unobtainable` | Stores deferred `UnobtainableCredentialError` instances per consumer and credential |

`held` is a `Map<string, unknown>` populated via `holdCredential(value, version = randomUUID())`, so resumed deploys start with an empty `held` map. `given` is a `WeakMap<BaseResource, Set<string>>` populated by `revealCredentials` and left empty for journal-replayed operations. `unobtainable` is a `WeakMap<BaseResource, Map<string, Error>>` keyed by `taker` and `${resource}.${name}` via `deferUnobtainable`.

When a resource operation runs, `revealCredentials(value, taker, recorded)` walks `value` with `mapChangedCredentials`.

If a marker matches `recorded` at the exact same object path, it substitutes `undefined` because the consumer already holds that version. Otherwise, it resolves the secret from `held` and records the version in `given`, or throws from `unobtainable`.

Because deferred errors throw only inside `revealCredentials`, a resumed deploy whose consumer operation replays from the journal succeeds without failing on unheld non-rotatable secrets.

On `create`, `holdCreated(resource, result)` extracts each schema `credential` property, validates it under `"create"`, registers it in `held`, and returns `{ key, credentials, invalid }`.

After applying an action, `findCredentialsNotReceived` inspects `given` (excluding credential sources and non-rotatable credentials). If a resumed consumer replayed an operation whose credential later rotated, `reconcileResource` re-reconciles it with `staleCredentials` passed to `markCredentialsStale`, resetting those marker versions to `null` in recorded `params` so the consumer updates.

## Credential Minting

`mintNeededCredentials` (`packages/reconciler/src/durable/credentials.ts`) runs on kept, non-`"creating"` producers before reconciliation reaches their consumers:

1. **Passed credentials** – For each matching `--credential` target, `applyPassedCredential` calls `holdPassedCredential`. It reads `process.env[target.variable]`, registers secret strings, validates under `"deploy"`, and checkpoints only `version` in `"passed"`; on replay without `held`, it reloads the variable under the saved `version` before `recordCredential` persists the marker.
2. **Consumer needs** – Step `"credentials:needed"` runs `getCredentialsToMint` across all consumers. It detects `"no-version"`, `"consumer-added"`, `"consumer-create-unfinished"`, and `"consumer-behind"` via `getChangedCredentials`.
3. **Eager rotation** – For unpassed needed credentials with `resource.rotate?.[name]`, `rotateStep` calls `rotate` in `"rotate"`, holds the returned value, and immediately persists the new marker with `recordCredential` because rotation revokes the prior secret. Non-rotatable credentials throw `UnobtainableCredentialError`.

## Credential Acquisition

`obtainCredentials` (`packages/reconciler/src/durable/credentials.ts`) runs immediately before a non-`noop` consumer operation whenever `findUnheldCredentials(received)` finds markers missing from `held`:

- **Credential sources** – Calls `loadSourceCredential`, which invokes `source.loadCredential`, validates under `"load"`, calls `recordSecretStrings`, and stores the value in `held` under the source's deterministic `version`.
- **Non-rotatable credentials** – Calls `deferUnobtainable` with `reason: "not-held"` so the error surfaces only if `revealCredentials` runs.
- **Rotatable credentials** – Loops `attempt = 0, 1, ...` calling `rotateStep` until `holdsCredential(version)` is true, skipping journaled attempts without an in-memory value. Once held, it updates the producer record, refreshes sibling consumers (`refresh:<id>`, `driftDetection: false`), and updates markers in `params`, `unnamedParams`, and `action.patch` via `refreshCredentialMarkers`.

## Source Prefetching

Plan and deploy read sources one at a time, in dependency order. So without help, the first read of a source can come halfway through a deploy, after other resources have changed. A source class can define the optional `prefetch` operation to fetch what all of its sources need at the start instead. For example, `OnePasswordSecret` uses it so that the 1Password desktop app shows at most one approval prompt, right after the command starts. See [1Password Internals](./1password-internals.md#fetching-items).

`prefetchSources` (`packages/reconciler/src/prefetch.ts`) runs `prefetch` in four steps:

1. **Load the outputs.** It loads the output of every resource from state with `loadOutput`.
2. **Plan the params.** For each source that has a `prefetch`, it plans the params with `planKnownParams`, as `validateKnownParams` does, and groups the source by its `prefetch` function. Every source of a class has the same function, so each group is one class. A source whose params hold an output that is not deployed yet is left out. Its own `read` fetches it later. A source whose params hold an output that is in state is passed with that output.
3. **Call each group.** It calls each group's `prefetch` once, with `{ id, params }` for every source in the group, and with `executionId`, `app`, `stage` and `notify`.
4. **Collect the failures.** It scrubs the message of each source in `failed` with `scrubSecretValues`, and after the last group throws one `SourcePrefetchError` that lists them all.

`prefetchSources` leaves the loaded outputs in place. Plan and deploy load each resource's output from state again before they plan or reconcile it, and they reach a resource's dependencies before it, so the outputs from step 1 do not change a decision.

A `prefetch` that throws stops the calls of the groups after it. `prefetchSources` scrubs the error with `scrubError` and rethrows it. A class throws in this way for a failure that concerns all of its sources, such as a missing `op` binary.

A `SourcePrefetchError` names each failed source, its type and its message:

```txt
2 sources could not be fetched.
  stripe-key (1password/secrets/OnePasswordSecret): <message>
  database-url (1password/secrets/OnePasswordSecret): <message>
```

`@notation/reconciler` exports `SourcePrefetchError` and the `FailedSource` type.

### When plan and deploy call it

| Command | Call site | Runs before |
| :--- | :--- | :--- |
| `plan` | `createPlan` (`packages/reconciler/src/planner.ts`), after `readRecordedOutputs` | The first `planResource` |
| `deploy` | `deploy()` (`packages/reconciler/src/durable/deploy.ts`), first statement after `assertDependenciesPresent` | The `notation:validate` step and the deployment hold |
| `destroy` | Not called | |

**The call in `deploy()` is not a durable step.** The durable runtime runs `deploy()` from the top on every delivery of the workflow, and replays the steps that finished from the journal. The result of `prefetch` is only in memory, so each delivery calls `prefetch` again, and uses nothing that an earlier delivery fetched. A delivery ends when the deploy suspends, so this happens on a resume, and also on the wake after a suspend, such as the wait for the deployment hold or a retry delay.

This has a cost for a later delivery. It replays the `read` of each source from the journal, and loads a value only for a consumer that is not written yet. `prefetch` still fetches every source, and a source that fails still fails the deploy, even when the delivery would not have loaded it. Such a failure can come after an earlier delivery changed resources. The engine can't tell a later delivery from the first before it replays the journal, so it uses one rule for all of them.

A plan, and the first delivery of a deploy, read every source anyway. So a source that fails in `prefetch` would have failed later, after other resources had changed. With `prefetch`, nothing has changed when it fails in a plan or in the first delivery.

### Passing the result to `read` and `loadCredential`

`prefetchSources` returns a `PrefetchedValues` map from each `prefetch` function to the `prefetched` value that it returned. The engine does not look inside the value:

- The planner keeps the map for the plan. `deploy()` keeps it in `DeployContext.prefetched` (`packages/reconciler/src/durable/types.ts`).
- `prefetchedFor(prefetched, source)` looks up the entry for the source's class. The planner and `sourceContext` (`packages/reconciler/src/durable/source.ts`) spread it into the context of `read` and `loadCredential` as `context.prefetched`.
- `context.prefetched` is undefined when the class has no `prefetch`, or when no source of the class had known params.
- The engine never writes the value to the journal or to state. It drops it when the plan or deploy ends.

The value is kept apart from `held`. `held` is keyed by credential version, and a source's credential version is a hash of its `revision`, which `read` computes later. At prefetch time there is no key. The engine still puts a value in `held` only when a consumer needs it.

### Notices

`context.notify(message)` emits a `reconciler.source.notice` event (`SourceNoticeEvent` in `packages/reconciler/src/events.ts`) with `level: "info"`, the class's `resourceType` and the message. `prefetchSources` does not await the emit, and ignores an emit that fails. The emitters in use, the pretty and NDJSON emitters of the CLI and the logger subscriber, write the event before they return. Pretty output (`formatPrettyEvent` in `packages/reconciler/src/logger-subscriber.ts`) shows the event as:

```txt
… Waiting for 1Password. Approve the request in the 1Password app. (1password/secrets/OnePasswordSecret)
```

## Source Versioning

`readAndDecideSource` (`packages/reconciler/src/sources.ts`) runs `source.readSource` inside `step.run("read", ...)`. It scrubs errors with `scrubError`, emits `reconciler.source.warning` for each `warn()` message, and passes the validated result to `decideSource`.

For every declared credential on the source, `decideSource` constructs a marker using `computeSourceCredentialVersion` (`packages/reconciler/src/credentials.ts`):

```ts [packages/reconciler/src/credentials.ts]
export function computeSourceCredentialVersion(
  source: BaseResource,
  name: string,
  params: Record<string, unknown>,
  revision: unknown,
): string {
  return createHash("sha256")
    .update(
      sortedJson.encode([
        source.id,
        name,
        toComparableParams(source.schema, params),
        revision,
      ]),
    )
    .digest("hex");
}
```

Because the version hashes only `source.id`, `name`, `toComparableParams`, and `revision`, identical source state yields the exact same `version` across deploys without rotating downstream consumers.

`decideSource` returns `"create"` when no non-`"creating"` record exists, `"update"` when `diffParams` or `isDeepStrictEqual` detects output or marker differences, and `"noop"` otherwise.

## Value Fingerprinting

Credential sources such as `sources.Env`, `sources.Dotenv`, and `InfisicalSecret` use `trackRevision` (`packages/std/src/track.ts`) to hash secret values into deterministic `revision` strings without storing plaintext. Every digest is salted with `JSON.stringify([scope.app, scope.stage, scope.id])` so identical secrets across apps, stages, or resource IDs yield distinct revisions:

- **`"scrypt"`** – Runs `crypto.scrypt(value, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })` and returns `scrypt:<hex>`. `maxmem` is 256 MiB because `N = 2^17` with `r = 8` requires 128 MiB, exceeding Node's 32 MiB default.
- **`"hmac"`** – Requires `process.env.NOTATION_TRACK_KEY` (`assertTrackKey`) and computes `HMAC-SHA256(key)` over `salt + "\0" + value`, returning `hmac:<hex>`.

`trackRevision` memoizes pending and resolved promises in a process-level `Map` keyed by `SHA-256(JSON.stringify([track, key, salt, value]))`. Rejected entries are deleted, and neither plaintext values nor track keys sit in the cache key.

## Redacted Wrapper

`Redacted<T>` (`packages/core/src/secrets/redacted.ts`) wraps secret strings in a private `#value` field to prevent accidental serialization or logging:

| Member | Behavior |
| :--- | :--- |
| `unwrap()` | Returns the underlying `#value` at the final provider boundary |
| `[Symbol.toPrimitive]()` | Throws `RedactedValueError` |
| `toString()` | Throws `RedactedValueError` |
| `toJSON()` | Throws `RedactedValueError` |
| `[Symbol.for("nodejs.util.inspect.custom")]()` | Returns `REDACTED_PLACEHOLDER` |

Coercion methods throw `RedactedValueError` instead of returning a placeholder that could be sent to a provider API. `REDACTED_PLACEHOLDER` evaluates to `"Redacted(<hidden>)"` for safe `console.log` and `util.inspect` output.

## Secret Scrubbing

`packages/utils/src/secret-values.ts` maintains a singleton registry on `globalThis[Symbol.for("@notation/utils/secret-values")]` so separate bundles in the same process scrub the same secret set. `recordSecretValue(value)` ignores empty strings and registers three representations per secret because provider SDKs may echo any of them in HTTP error payloads:

| Form | Encoding |
| :--- | :--- |
| Raw | Exact `value` string |
| Base64 | `Buffer.from(value, "utf8").toString("base64")` |
| JSON-escaped | `JSON.stringify(value).slice(1, -1)` |

`scrubSecretValues(text)` lazily sorts registered patterns longest-first so shorter substrings cannot leave fragments of longer secrets behind, replacing matches with `SCRUBBED` (`"<hidden>"`).

`scrubError(error)` rewrites `message` and `stack` in place while preserving the error class. It walks `cause` and `errors` recursively with a `seen` `Set` to guard against reference cycles.
