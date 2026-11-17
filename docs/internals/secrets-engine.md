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
