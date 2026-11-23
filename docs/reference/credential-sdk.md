# Credential SDK

`@notation/resource`, `@notation/std/track`, `@notation/core`, `@notation/reconciler`, and `@notation/infisical/resources` provide the builder APIs, hashing utilities, redaction wrapper, error classes, and scrubbing helpers used to author and consume credential sources. See [Credential Sources](../authoring/credential-sources.md) for a practical authoring guide.

## Credential source builder

Define an external secret source class with `credentialSourceResource<ApiSchema>(meta)` from `@notation/resource` followed by `.defineSchema(schema)` and `.defineOperations({ prefetch, read, loadCredential })`. `prefetch` is optional.

### `credentialSourceResource`

`credentialSourceResource` creates a `CredentialSourceClass` with `kind: "credential-source"` and `blocksDeleteOf: []`:

```ts [@notation/resource]
export function credentialSourceResource<
  Api extends DefineCredentialSourceApiSchema,
>(meta: {
  type: ResourceType;
  provider: string;
}): CredentialSourceBuilder<Api>;
```

Deploy never creates, updates, or remotely deletes a credential source; parameter changes update state directly, and `delete` is a no-op.

### `isCredentialSource`

`isCredentialSource(resource)` checks `resource.kind === "credential-source"` to narrow `BaseResource` to `BaseCredentialSource` across installed package copies:

```ts [@notation/resource]
export function isCredentialSource(
  resource: Pick<BaseResource, "kind">,
): resource is BaseCredentialSource;
```

## Source schema

Credential source schemas bind constructor parameters, the required `revision` output, optional extra computed outputs, and a single `value` credential.

### `DefineCredentialSourceApiSchema`

Pass `<Api>` to `credentialSourceResource<Api>(meta)` to enforce parameter and credential value types against your external client:

```ts [@notation/resource]
export type DefineCredentialSourceApiSchema = {
  Params: any;
  Value: any;
};
```

Calling `credentialSourceResource(meta)` without `<Api>` skips compile-time checks against `Params` and `Value`.

### `CredentialSourceSchema`

`CredentialSourceSchema<Api>` maps all `Params` as mutable `"param"` properties, requires `revision` as a `"computed"` string, permits extra `"computed"` outputs, and requires a `"credential"` property named `value`:

```ts [@notation/resource]
type CredentialSourceSchema<Api extends DefineCredentialSourceApiSchema> =
  Schema &
    SchemaFromApi<{}, Api["Params"], Api["Params"], { revision: string }> & {
      value: SchemaItem<Api["Value"]> & { propertyType: "credential" };
    };
```

Declaring any `"credential"` property other than `value` throws synchronously inside `.defineSchema(...)`. Every schema validator must implement `StandardSchemaV1<T, T>`; failures on `value` or `sensitive: true` fields mask error details with `"Invalid sensitive value"`.

## Source operations

`.defineOperations({ prefetch, read, loadCredential })` separates metadata inspection from plaintext secret loading (see [Secrets Engine](../internals/secrets-engine.md)). `defineOperations` takes one type parameter, `Prefetched`, which is the type of the value that `prefetch` returns. It defaults to `undefined`:

```ts [@notation/resource]
defineOperations: <Prefetched = undefined>(
  opts: CredentialSourceOperations<InferResourceTypes<ResolveSchema<S>>, Prefetched>,
) => CredentialSourceClass<InferResourceTypes<ResolveSchema<S>>>;
```

### `CredentialSourceContext`

Passed as the second argument to `loadCredential` and extended by `CredentialSourceReadContext`:

```ts [@notation/resource]
export type CredentialSourceContext<Prefetched = unknown> = {
  id: string;
  executionId: string;
  app: string;
  stage: string;
  prefetched?: Prefetched;
};
```

`executionId` remains constant across resumes of a single deploy and is regenerated for each `plan`.

`prefetched` is what the class's `prefetch` returned. It is undefined when the class has no `prefetch`, or when the source depends on another resource.

### `CredentialSourceReadContext`

Passed as the second argument to `read`:

```ts [@notation/resource]
export type CredentialSourceReadContext<
  State = any,
  Prefetched = unknown,
> = CredentialSourceContext<Prefetched> & {
  state: State | undefined;
  warn(message: string): void;
};
```

`state` holds previously recorded params and computed outputs (excluding `hidden` params and credentials), or `undefined` when no state record exists. Call `warn(message)` to display a warning for the source during `plan` and `deploy`.

### `prefetch`

An optional operation that fetches what every source of the class needs, before plan or deploy plans or changes any resource. Use it when a source's backend should be called once at the start, rather than once for each source as the engine reaches it. For example, `OnePasswordSecret` from `@notation/1password` uses it so that the 1Password desktop app shows one approval prompt at the start of a deploy.

```ts [@notation/resource]
prefetch?: (
  sources: PrefetchedSource<T["params"]>[],
  context: CredentialSourcePrefetchContext,
) => Promise<CredentialSourcePrefetchResult<Prefetched>>;

export type PrefetchedSource<Params = any> = {
  id: string;
  params: Params;
};

export type CredentialSourcePrefetchContext = {
  executionId: string;
  app: string;
  stage: string;
  notify(message: string): void;
};

export type CredentialSourcePrefetchResult<Prefetched = unknown> = {
  prefetched: Prefetched;
  failed: { id: string; error: Error }[];
};
```

Plan and deploy call `prefetch` once for each class, before they plan or change any resource. They pass every source of the class whose params are known and that depends on no other resource. `destroy` does not call it. For when a resumed deploy calls it again, see [Secrets Engine](../internals/secrets-engine.md#source-prefetching).

`prefetch` returns two things:

- **`prefetched`** – Any value that `read` and `loadCredential` need. The engine passes it to them as `context.prefetched`, and keeps it only in memory.
- **`failed`** – The sources that `prefetch` could not fetch, each with its error. Plan and deploy throw one `SourcePrefetchError` that lists them.

**`read` and `loadCredential` must still work without `context.prefetched`**, because some sources are not passed to `prefetch`. Throw from `prefetch` for a failure that concerns every source, such as a missing CLI. Call `context.notify(message)` to show a message in the output, for example while `prefetch` waits for the user. Call `recordSecretValue` on every value that `prefetch` fetches.

A minimal `prefetch` that fetches each source once, and that `read` uses:

```ts [packages/acme/src/resources/acme-secret.ts]
.defineOperations<Map<string, AcmeSecret>>({
  prefetch: async (sources) => {
    const prefetched = new Map<string, AcmeSecret>();
    const failed: { id: string; error: Error }[] = [];
    for (const source of sources) {
      try {
        const secret = await getSecret(source.params.key);
        recordSecretValue(secret.value);
        prefetched.set(source.params.key, secret);
      } catch (error) {
        failed.push({ id: source.id, error: error as Error });
      }
    }
    return { prefetched, failed };
  },
  read: async (params, context) => {
    const secret =
      context.prefetched?.get(params.key) ?? (await getSecret(params.key)); // ← fall back for unfetched sources
    return { revision: `version:${secret.id}:${secret.version}` };
  },
  // ...
});
```

### `read`

Called during `plan` and `deploy` to compute `revision` and any extra `"computed"` outputs without returning plaintext secrets:

```ts [@notation/resource]
read: (
  params: T["params"],
  context: CredentialSourceReadContext<T["state"], Prefetched>,
) => Promise<CredentialSourceReadResult<T>>;
```

`CredentialSourceReadResult<T>` equals `Omit<T["state"], keyof T["params"]>`. Notation strips any `"credential"` fields returned by `read` before validation and persistence.

### `loadCredential`

Called during `deploy` only when a downstream consumer creates, updates, or replaces and the current process does not yet hold the secret value:

```ts [@notation/resource]
loadCredential: (
  state: T["state"],
  context: CredentialSourceContext<Prefetched>,
) => Promise<T["credentials"]["value"]>;
```

`state` holds the recorded params and computed outputs returned by `read`. Returning `undefined` or an invalid value fails validation immediately.

## Revision tracking

`@notation/std/track` hashes unversioned secrets into deterministic `revision` strings salted by deployment scope.

### Track types

`@notation/std/track` exports the tracking mode union, scope shape, Valibot validator, and environment variable constant:

```ts [@notation/std/track]
export type Track = "scrypt" | "hmac";

export type TrackScope = {
  app: string;
  stage: string;
  id: string;
};

export const TRACK_KEY_VARIABLE = "NOTATION_TRACK_KEY";

export const trackValidator = v.picklist(["scrypt", "hmac"]);
```

`CredentialSourceContext` satisfies `TrackScope` directly.

### `assertTrackKey`

Validates that `process.env.NOTATION_TRACK_KEY` is set whenever `track` is `"hmac"`, throwing a descriptive error otherwise:

```ts [@notation/std/track]
export function assertTrackKey(track: Track): void;
```

Call `assertTrackKey` in both `read` and `loadCredential` before hashing so missing keys fail fast.

### `trackRevision`

Computes a scoped revision digest (`hmac:<hex>` or `scrypt:<hex>`) and caches the promise in memory for the current process:

```ts [@notation/std/track]
export function trackRevision(
  track: Track,
  scope: TrackScope,
  value: string,
): Promise<string>;
```

`trackRevision` calls `assertTrackKey(track)` automatically and salts the hash with `[scope.app, scope.stage, scope.id]` so identical values across stages or sources produce distinct revisions. Use `"hmac"` for arbitrary or low-entropy secrets (requiring `NOTATION_TRACK_KEY`) and `"scrypt"` only for high-entropy generated secrets.

## Credential errors

Three error classes handle external secret replacement, sources that `prefetch` could not fetch, and missing rotation paths.

### `SecretReplacedError`

Exported from `@notation/infisical/resources` and thrown by `InfisicalSecret` when a secret was deleted and recreated under the same key between `read` and `loadCredential`:

```ts [@notation/infisical/resources]
export class SecretReplacedError extends Error {
  constructor(address: SecretAddress);
}
```

Custom credential sources for versioned stores should follow the same pattern by pinning an immutable secret ID alongside the version number in `revision` and throwing when the ID changes. `ItemReplacedError` from `@notation/1password/resources` follows it for 1Password items.

### `SourcePrefetchError`

Exported from `@notation/reconciler`. Thrown by `plan` and `deploy` when a class's `prefetch` returns sources in `failed`:

```ts [@notation/reconciler]
export type FailedSource = {
  id: string;
  type: ResourceType;
  message: string;
};

export class SourcePrefetchError extends Error {
  readonly _tag = "SourcePrefetchError" as const;
  readonly failed: readonly FailedSource[];
  constructor(failed: readonly FailedSource[]);
  static is(error: unknown): error is SourcePrefetchError;
}
```

`message` is the source's error message, passed through `scrubSecretValues`.

### `UnobtainableCredentialError`

Exported from `@notation/core` and `@notation/reconciler`. Thrown during `plan` and `deploy` when a consumer requires a credential without a `rotate` operation, the current process holds no plaintext value, and neither `--credential` nor `--replace` targets it:

```ts [@notation/core]
export type CredentialNeed =
  | "no-version"
  | "consumer-added"
  | "consumer-create-unfinished"
  | "consumer-replaced"
  | "consumer-behind"
  | "not-held";

export type UnobtainableCredential = {
  consumer: string;
  producer: string;
  producerType: string;
  name: string;
  reason: CredentialNeed;
  rotateManually?: string;
  instanceHash?: string;
};

export class UnobtainableCredentialError extends Error {
  readonly _tag = "UnobtainableCredentialError" as const;
  readonly credentials: readonly UnobtainableCredential[];
  readonly overrides?: Overrides;
  constructor(
    credentials: readonly UnobtainableCredential[],
    overrides?: Overrides,
    deployCommand?: string,
    options?: ErrorOptions,
  );
  static is(error: unknown): error is UnobtainableCredentialError;
}
```

The formatted message includes `rotateManually` instructions (when defined) alongside exact `--credential` and `--replace` CLI flags. Each entry's `reason` identifies why the credential is required:

| Reason | Description |
| :--- | :--- |
| `"no-version"` | Producer state record has no version for the credential |
| `"consumer-added"` | Consumer has no state record yet |
| `"consumer-create-unfinished"` | Consumer has an unfinished `"creating"` state record |
| `"consumer-replaced"` | Deploy is replacing the consumer |
| `"consumer-behind"` | Consumer state record holds an older credential version |
| `"not-held"` | Consumer operation needs the value, but the current process holds none |

## Secret redaction

`Redacted<T>` from `@notation/core` wraps a secret value in memory so accidental serialization or logging never leaks plaintext bytes:

```ts [@notation/core]
export const REDACTED_PLACEHOLDER = "Redacted(<hidden>)";

export class RedactedValueError extends Error {
  constructor(use: string);
}

export class Redacted<T = string> {
  constructor(value: T);
  unwrap(): T;
  [Symbol.toPrimitive](): never;
  toString(): never;
  toJSON(): never;
  [inspectCustom](): string;
}
```

`unwrap()` returns the underlying value `T`. Template interpolation, `String(val)`, numeric coercion, and `JSON.stringify(val)` throw `RedactedValueError`, while `console.log` and `util.inspect` print `"Redacted(<hidden>)"`.

## Error scrubbing

`@notation/core` (re-exporting from `@notation/utils`) provides process-wide secret scrubbing helpers.

### `recordSecretValue`

Registers a non-empty string secret so `scrubSecretValues` and `scrubError` redact it (along with its base64 and JSON-escaped representations) for the remainder of the process:

```ts [@notation/core]
export function recordSecretValue(value: string): void;
```

Notation automatically registers values returned by `create`, `rotate`, and `loadCredential`. Call `recordSecretValue(secret)` inside `read` whenever a source inspects plaintext secret bytes in memory.

### `scrubSecretValues`

Replaces every recorded secret pattern in `text` with `"<hidden>"`, matching longer values before shorter substrings:

```ts [@notation/core]
export function scrubSecretValues(text: string): string;
```

### `scrubError`

Scrubs recorded secret values in place from `error.message`, `error.stack`, `error.cause`, and `error.errors` (for `AggregateError` chains) while preserving the original error instance and class:

```ts [@notation/core]
export function scrubError<T>(error: T): T;
```
