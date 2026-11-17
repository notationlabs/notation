# Infisical Internals

`@notation/infisical` fetches shared secrets over Infisical's REST API and caches machine-identity access tokens in-process. It also detects secret references via parallel probes, derives deterministic credential versions, and scrubs secret values from error paths.

## API configuration

### Domain normalization

`siteUrl()` (`packages/infisical/src/api.ts`) defaults `INFISICAL_DOMAIN` to `DEFAULT_SITE_URL` (`"https://app.infisical.com"`), trims trailing slashes, and strips a trailing `/api` suffix while keeping non-`/api` path prefixes such as `/infisical`:

```ts [packages/infisical/src/api.ts]
export function siteUrl(): string {
  const url = process.env.INFISICAL_DOMAIN ?? DEFAULT_SITE_URL;
  return url.replace(/\/+$/, "").replace(/\/api$/, "");
}
```

### Request timeouts

`request()` enforces `REQUEST_TIMEOUT_MS = 30_000` (30 seconds) via `AbortSignal.timeout`. Non-2xx responses throw `InfisicalApiError` populated from `body.message` when present or trimmed response text otherwise.

## Authentication

`cachedAccessToken(site)` (`packages/infisical/src/auth.ts`) resolves credentials in three tiers:

1. **Direct token** – `INFISICAL_TOKEN` is returned immediately (`Promise.resolve`) with no login request or caching.
2. **Universal Auth** – `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` (throws if only one is set) exchange via `POST /api/v1/auth/universal-auth/login` with `{ clientId, clientSecret }`.
3. **OIDC Auth** – `INFISICAL_IDENTITY_ID` exchanges `{ identityId, jwt }` via `POST /api/v1/auth/oidc-auth/login`. It reads `INFISICAL_JWT` first, or requests a GitHub Actions JWT (`ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, plus `audience` when `INFISICAL_OIDC_AUDIENCE` is set).

### Token caching

`logins` (`Map<string, { token: Promise<string>; expiresAt: number }>`) keys cached tokens by `JSON.stringify([site, clientId, clientSecret, identityId, jwt])`. On login success, `expiresAt` is set to `Date.now() + ((response.expiresIn ?? DEFAULT_LIFETIME_SECONDS) * 1000) / 2` (`DEFAULT_LIFETIME_SECONDS = 600`), caching tokens for half their reported lifetime (`expiresIn / 2`).

### Single-flight login

When no unexpired entry exists in `logins`, `cachedAccessToken` stores `{ token, expiresAt: Infinity }` synchronously before awaiting `login(site)`. Concurrent secret reads in the same process therefore share one in-flight login request. If `login(site)` rejects, the `.catch` handler removes the entry from `logins` so subsequent calls retry.

## Secret retrieval

`getSecret(address, options)` (`packages/infisical/src/resources/client.ts`) issues `GET /api/v4/secrets/${encodeURIComponent(address.key)}` with fixed and optional query parameters:

| Parameter | Value |
| :--- | :--- |
| `projectId` | `address.projectId` |
| `environment` | `address.environment` |
| `secretPath` | Normalized path with leading `/` and no trailing `/` |
| `type` | `"shared"` |
| `viewSecretValue` | `"true"` |
| `expandSecretReferences` | `"true"` or `"false"` |
| `includeImports` | `"true"` |
| `version` | `String(options.version)` when pinning a specific revision |

`normalisePath` normalizes `secretPath`. Setting `type` to `"shared"` excludes personal user overrides from shared deployments, and `includeImports: "true"` includes secrets imported into the folder.

HTTP `404` responses map to a location-specific error (`where(address)`). If the response sets `secret.secretValueHidden` to `true`, `getSecret` throws immediately so hidden permissions never resolve as empty or placeholder strings.

## Revision tracking

`InfisicalSecret` (`packages/infisical/src/resources/infisical-secret.ts`) uses `credentialSourceResource` (see [Secrets Engine](./secrets-engine.md)) to separate version discovery (`read`) from secret material retrieval (`loadCredential`).

### Credential version hashing

The reconciler computes a source credential's `version` in `computeSourceCredentialVersion` (`packages/reconciler/src/credentials.ts`) as a SHA-256 hex digest over `[source.id, name, toComparableParams(source.schema, params), revision]`. Keeping `revision` stable across deploys prevents downstream consumers from updating when the secret has not changed.

### Reference probes

When `track` is unset, Infisical's API does not report whether a secret's stored value contains `${...}` references.

`InfisicalSecret.read` issues two `getSecret` requests in parallel (`expandSecretReferences: false` and `expandSecretReferences: true`) and compares `stored.secretValue` with `expanded.secretValue`:

```ts [packages/infisical/src/resources/infisical-secret.ts]
const [stored, expanded] = await Promise.all([
  getSecret(params, { expandSecretReferences: false }),
  getSecret(params, { expandSecretReferences: true }),
]);
recordSecretValue(stored.secretValue);
recordSecretValue(expanded.secretValue);
assertNotEmpty(params, expanded.secretValue);
if (stored.secretValue !== expanded.secretValue) {
  return { revision: `exec:${context.executionId}` };
}
return { revision: `version:${stored.id}:${stored.version}` };
```

- **Secret with references (`exec:<executionId>`)** – Upstream referenced secrets can change without incrementing this secret's `version`. `read` therefore pins the deploy execution ID and updates consumers on every deploy.
- **Static secret (`version:<id>:<version>`)** – Pins both `stored.id` and `stored.version` so consumers update only when the secret changes. Including `id` distinguishes a deleted-and-recreated secret whose version counter restarted at `1`.

### Tracked revision salting

When `track` is `"hmac"` or `"scrypt"`, `read` fetches only `expandSecretReferences: true` and delegates to `trackRevision(params.track, context, secret.secretValue)` (`packages/std/src/track.ts`):

- **Scope salting** – Salts the hash with `JSON.stringify([scope.app, scope.stage, scope.id])` so identical secret values in different apps, stages, or resource IDs yield distinct revisions.
- **HMAC mode** – Requires `NOTATION_TRACK_KEY` (`assertTrackKey`) and computes `HMAC-SHA256(key, salt + "\0" + value)` (`hmac:<hex>`).
- **Scrypt mode** – Derives a 32-byte digest with `N = 2^17`, `r = 8`, `p = 1`, `maxmem = 256 MiB` (`scrypt:<hex>`).
- **Process cache** – Caches promises by `SHA-256(JSON.stringify([track, key, salt, value]))` and removes rejected entries.

## Credential loading

`InfisicalSecret.loadCredential` parses `state.revision` via `parseRevision` (`version:<id>:<version>`, `exec:<executionId>`, `hmac:<hex>`, or `scrypt:<hex>`), verifies that `track` matches the recorded revision kind, and enforces consistency checks:

- **Deleted and recreated secret** – On `version:` revisions, `loadCredential` fetches `getSecret` with `expandSecretReferences: false` and `version: revision.version`. If `secret.id !== revision.id`, it throws `SecretReplacedError` rather than reading a different secret's version `N`.
- **Mid-deploy version change** – For imported secrets, Infisical ignores `version` and returns the current version. If `secret.version !== revision.version`, `loadCredential` throws and requires a fresh deploy.
- **Mid-deploy tracked change** – For `track` revisions, `loadCredential` re-computes `trackRevision` on the expanded value and throws if it no longer matches `state.revision`.
- **Empty values** – Both `read` and `loadCredential` call `assertNotEmpty` to reject `""` values.

## Secret scrubbing

`InfisicalSecret.read` calls `recordSecretValue` (`packages/utils/src/secret-values.ts`) on every fetched secret string immediately after `getSecret` returns, before `assertNotEmpty` or `trackRevision` can throw:

- **Recorded variants** – Registers the raw `value`, `Buffer.from(value, "utf8").toString("base64")`, and `JSON.stringify(value).slice(1, -1)` (JSON-escaped form) in a `globalThis[Symbol.for("@notation/utils/secret-values")]` set.
- **Longest-first replacement** – `scrubSecretValues` and `scrubError` replace all recorded forms (sorted longest-first) with `"<hidden>"` (`SCRUBBED`) across error `message`, `stack`, `cause`, and `errors` arrays.
