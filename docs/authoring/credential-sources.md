# Credential Sources

Author custom credential source plugins with `@notation/resource` to pull secrets from external vaults, files, or internal stores without storing plaintext in state. Modeling secret changes through an opaque `revision` string lets Notation detect rotations across machines, keep unchanged consumers untouched, and hold secret bytes strictly in process memory.

Install `@notation/resource` alongside a [Standard Schema V1](https://standardschema.dev) validator such as Valibot:

```sh [Terminal]
@pm.add("@notation/resource")
@pm.add("valibot")
```

## Source definition

Define a credential source in three chained calls starting from `credentialSourceResource<ApiSchema>(meta)`, instantiate it in `infra/`, and bind `source.credentials.value` in a runtime declaration:

::code-group

```ts [src/local-token.ts]
import fs from "node:fs/promises";
import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";

async function readTokenFile(filePath: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

export type LocalTokenApi = {
  Params: { path: string };
  Value: string;
};

export const LocalToken = credentialSourceResource<LocalTokenApi>({
  type: "acme/local/LocalToken",
  provider: "@acme/local/resources",
})
  .defineSchema({
    path: { propertyType: "param", presence: "required", value: v.string() },
    revision: { propertyType: "computed", presence: "required", value: v.string() },
    value: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    read: async (_params, context) => ({ revision: context.executionId }),
    loadCredential: async (state) => {
      const secret = await readTokenFile(state.path);
      if (!secret) throw new Error(`${state.path} is missing or empty.`);
      return secret;
    },
  });
```

```ts [infra/secrets.ts]
import { LocalToken } from "../src/local-token";

export const apiToken = new LocalToken("api-token", {
  config: { path: ".secrets/api-token" },
});
```

```ts [runtime/orders.ts]
import { $lambda, type LambdaHandler } from "@notation/aws/lambda";
import { apiToken } from "../infra/secrets";

export const orders = $lambda({
  id: "orders",
  env: () => ({ API_TOKEN: apiToken.credentials.value }),
});

export const handler: LambdaHandler<typeof orders> = async () => {
  const { API_TOKEN } = orders.env();
  return { configured: API_TOKEN.length > 0 };
};
```

::

Every credential source splits inspection (`read`) from secret loading (`loadCredential`) and follows three rules:

- **One `value` credential and `revision` output** – Every source exposes a single `"credential"` property named `value` and a required `"computed"` `revision` output; Notation strips any credential returned from `read`.
- **On-demand loading** – `read` runs during `plan` and `deploy`, while `loadCredential` runs during `deploy` only when a downstream consumer changes and the current process does not yet hold the secret.
- **No-op vs. per-deploy revisions** – Returning `context.executionId` in `read` changes the credential version on every deploy and updates every consumer; returning a stable revision leaves unchanged consumers alone.

## Deterministic tracking

Stores without version numbers – such as local files or environment variables – can hash secret bytes into deterministic revisions with `@notation/std/track` and scrub in-memory plaintext with `@notation/core`.

Install `@notation/std` and `@notation/core`:

```sh [Terminal]
@pm.add("@notation/std")
@pm.add("@notation/core")
```

Add an optional `track` parameter to `LocalToken` so unchanged secrets produce the same `revision` across deploys:

```ts [src/local-token.ts]
import * as v from "valibot";
import { recordSecretValue } from "@notation/core";
import { credentialSourceResource } from "@notation/resource";
import { assertTrackKey, trackRevision, trackValidator, type Track } from "@notation/std/track";

type LocalTokenApi = { Params: { path: string; track?: Track }; Value: string };

export const LocalToken = credentialSourceResource<LocalTokenApi>({
  type: "acme/local/LocalToken",
  provider: "@acme/local/resources",
})
  .defineSchema({
    path: { propertyType: "param", presence: "required", value: v.string() },
    track: { propertyType: "param", presence: "optional", value: trackValidator },
    revision: { propertyType: "computed", presence: "required", value: v.string() },
    value: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    read: async (params, context) => {
      if (!params.track) return { revision: context.executionId };
      assertTrackKey(params.track);
      const secret = await readTokenFile(params.path);
      if (secret === undefined && context.state?.revision !== undefined) {
        context.warn(`${params.path} is missing. Its value was not checked for a change.`);
        return { revision: context.state.revision };
      }
      if (!secret) throw new Error(`${params.path} is missing or empty.`);
      recordSecretValue(secret);
      return { revision: await trackRevision(params.track, context, secret) };
    },
    loadCredential: async (state, context) => {
      if (state.track) assertTrackKey(state.track);
      const secret = await readTokenFile(state.path);
      if (!secret) throw new Error(`${state.path} is missing or empty.`);
      if (state.track && (await trackRevision(state.track, context, secret)) !== state.revision) {
        throw new Error(`${context.id} changed after read. Run deploy again.`);
      }
      return secret;
    },
  });
```

Three design details make tracked local sources safe in teams and CI:

- **Fallback on `context.state?.revision`** – Returning the recorded revision with `context.warn(...)` prevents blocking `plan` or unrelated deploys when a local secret file is absent on another machine.
- **Re-verify inside `loadCredential`** – Comparing `trackRevision(...)` against `state.revision` rejects mid-deploy edits before mismatched bytes reach a consumer.
- **Match `track` mode to entropy** – `"hmac"` hashes any secret with `NOTATION_TRACK_KEY`, whereas `"scrypt"` requires no external key and should only be used for high-entropy generated secrets.

## Stale read protection

Because `read` runs before consumer reconciliation – or in an earlier interrupted deploy before resume – an external vault secret can be updated, deleted, or recreated before `loadCredential` runs.

Pin both the secret's immutable ID and version number in `revision`, then verify both inside `loadCredential`:

```ts [src/vault-secret.ts]
read: async (params) => {
  const meta = await vaultClient.getMetadata(params.namespace, params.key);
  return { revision: `version:${meta.id}:${meta.version}` };
},
loadCredential: async (state) => {
  const [, id, version] = state.revision.split(":");
  const secret = await vaultClient.getSecretVersion(state.namespace, state.key, Number(version));
  if (secret.id !== id) {
    throw new Error(`\`${state.key}\` was deleted and recreated after read. Run deploy again.`);
  }
  if (secret.version !== Number(version)) {
    throw new Error(`\`${state.key}\` returned version ${secret.version} instead of ${version}.`);
  }
  return secret.value;
},
```

Pinning only the version number allows a deleted-and-recreated secret (whose version counter resets to `1`) to masquerade under the old revision. When a vault supports dynamic references (such as interpolated `${...}` secrets) that change without bumping the parent version, hash the expanded plaintext with `trackRevision` or return `` `exec:${context.executionId}` ``.

## Secret scrubbing

Notation registers every string returned by `loadCredential` and scrubs step errors before printing or persisting them. Whenever `read` inspects plaintext in memory – before hashing or returning – call `recordSecretValue(secret)` from `@notation/core` immediately so thrown errors never leak secret bytes.
