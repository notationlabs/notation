# Secrets

`@notation/cloudflare` keeps secrets in the account's [Secrets Store](https://developers.cloudflare.com/secrets-store/), and binds them to Workers. Notation records where a secret is, such as the store ID and the name, and where its value comes from. It never records the secret's value.

Deploy writes a secret's value from its source, or asks for it when the secret has no source. See [Secrets](../../manual/secrets.md). An API token declared with `accountToken()` writes its own value.

## `secret(config)`

An infra module calls `secret` to declare a secret, and a Worker binds it with `secretsStore.bind`:

::code-group

```ts [infra/secrets.ts]
import { secret } from "@notation/cloudflare/secrets-store";
import { env } from "@notation/std/sources";

export const stripeKey = secret({
  id: "stripe-key",
  source: env,
  key: "STRIPE_KEY",
});
```

```ts [runtime/api.ts]
import {
  $worker,
  secretsStore,
  type WorkerHandler,
} from "@notation/cloudflare/workers";
import { stripeKey } from "../infra/secrets";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ STRIPE_KEY: secretsStore.bind(stripeKey) }),
});

export default {
  async fetch(request, env) {
    const key = await env.STRIPE_KEY.get();
    return new Response(key ? "configured" : "missing");
  },
} satisfies WorkerHandler<typeof worker>;
```

::

| Option   | Description                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Keys the secret in state, and is what `notation secret set <id>` takes. The secret's name in the store is `<app>--<stage>--<id>`, such as `shop--dev--stripe-key`.                                              |
| `source` | Where the value comes from, such as `env` or `dotenv(".env.local")` from `@notation/std/sources`. Given together with `key`. Without a source, deploy asks for the value.                                       |
| `key`    | The key that the source is asked for.                                                                                                                                                                           |
| `name`   | An exact name in the store, in place of `<app>--<stage>--<id>`. The name isn't scoped to the stage. Use it to adopt a secret that exists, or to share one between stages. Cloudflare rejects a name with a dot. |

- Deploy writes the value when it creates the secret, and when the source's version of the key changes. For `env` and `dotenv`, that is every deploy. A new secret gets the scope Workers. A secret that exists keeps its scopes.
- A secret without a source is written only when it is missing. Deploy asks for the value on a terminal, and fails without one. Set it first with [`notation secret set`](../../cli/secret.md), or with wrangler or in the dashboard.
- Deploy finds the secret by its name. A secret that is deleted later is seen as drift, and the next deploy creates it again from its source or the prompt.
- Destroy deletes a secret whose name is `<app>--<stage>--<id>`. It leaves a secret with an explicit `name`.
- Cloudflare never returns a secret's value, so a value changed in the dashboard or with wrangler isn't seen as a change. It stays until the next write.

## `accountToken(config)`

`accountToken` declares an account-owned API token. Cloudflare returns a token's value only when it creates the token. So the create writes the value to a secret in the same step, and the value never reaches state. The secret has the token's name, `<app>--<stage>--<id>`.

::code-group

```ts [infra/tokens.ts]
import { accountToken } from "@notation/cloudflare/tokens";

export const deployToken = accountToken({
  id: "deploy",
  policies: [
    {
      effect: "allow",
      permissionGroups: ["Workers Scripts Write"],
      resources: { "com.cloudflare.api.account.<account id>": "*" },
    },
  ],
});
```

```ts [runtime/ci.ts]
import { $worker, secretsStore } from "@notation/cloudflare/workers";
import { deployToken } from "../infra/tokens";

export const worker = $worker({
  id: "ci",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ DEPLOY_TOKEN: secretsStore.bind(deployToken) }),
});
```

::

| Option     | Description                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | Keys the token in state, and names the token and its secret `<app>--<stage>--<id>`. Changing the id rotates the token: deploy creates a new token and secret, and deletes the old ones.                         |
| `policies` | What the token can do. Each policy has an `effect`, `allow` or `deny`, the names of its `permissionGroups` as the dashboard shows them, and the `resources` it applies to. A change updates the token in place. |

- A change to the policies updates the token, which keeps its value.
- Plan looks up the ID of each permission group by its name, and compares the IDs with the token's. A name can belong to more than one group, one for each scope. Then the scope of the policy's `resources` picks the group: `com.cloudflare.api.account.<account id>` picks the account group, and `com.cloudflare.api.account.zone.<zone id>` picks the zone group. If the resources have more than one scope, plan fails and lists the groups. Give each scope its own policy.
- If the token's secret is deleted, plan fails, because the value can't be fetched again. Rotate the token by changing its `id`.
- Destroy deletes the token and its secret.
- `notation secret set` and `notation secret delete` refuse a token's secret.

## `secretsStore.bind(secret)`

`secretsStore.bind` binds a secret from `secret()` or a token from `accountToken()` to a Worker, as a Secrets Store binding. In the Worker, the binding has the type `SecretsStoreSecret`, and the code reads the value with `await env.NAME.get()`. The Worker is uploaded after the secret, because Cloudflare fails an upload that binds a secret that doesn't exist.

## The store

Cloudflare allows one Secrets Store for each account, and every app and stage in the account shares it. A declaration of a secret or a token adds the store as the resource `secrets-store`. Deploy adopts the account's store, or creates one named `default_secrets_store`, the name that the dashboard uses. Destroy leaves the store.

## Credentials

`CLOUDFLARE_API_TOKEN` needs these permissions, besides those in [Workers](workers.md#credentials):

- **Secrets Store: Edit**, for secrets and tokens.
- **Account API Tokens: Edit**, for `accountToken()`.
