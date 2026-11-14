# Secrets

`@notation/cloudflare` keeps secrets in the account's [Secrets Store](https://developers.cloudflare.com/secrets-store/), and binds them to Workers. Notation records where a secret is, such as the store ID and the name, and where its value comes from. It never records the secret's value.

Deploy writes a secret's value from its source, or asks for it when the secret has no source. See [Secrets](../../manual/secrets.md). A secret can also take a value that another resource gets when it is created, such as the value of an API token from `accountToken()`. See [Produced sources](#produced-sources).

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

| Option   | Description                                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`     | Keys the secret in state, and is what `notation secret set <id>` takes. The secret's name in the store is `<app>--<stage>--<id>`, such as `shop--dev--stripe-key`.                                                                                                       |
| `source` | Where the value comes from, such as `env` or `dotenv(".env.local")` from `@notation/std/sources`. Given together with `key`. Without a source, deploy asks for the value. A [produced source](#produced-sources), such as `token.sources.value`, is given without `key`. |
| `key`    | The key that the source is asked for. Not given with a produced source.                                                                                                                                                                                                  |
| `name`   | An exact name in the store, in place of `<app>--<stage>--<id>`. The name isn't scoped to the stage. Use it to adopt a secret that exists, or to share one between stages. Cloudflare rejects a name with a dot.                                                          |

- Deploy writes the value when it creates the secret, and when the source's version of the key changes. For `env` and `dotenv`, that is every deploy. A new secret gets the scope Workers. A secret that exists keeps its scopes.
- A secret without a source is written only when it is missing. Deploy asks for the value on a terminal, and fails without one. Set it first with [`notation secret set`](../../cli/secret.md), or with wrangler or in the dashboard.
- Deploy finds the secret by its name. A secret that is deleted later is seen as drift, and the next deploy creates it again from its source or the prompt.
- Destroy deletes a secret whose name is `<app>--<stage>--<id>`. It leaves a secret with an explicit `name`.
- Cloudflare never returns a secret's value, so a value changed in the dashboard or with wrangler isn't seen as a change. It stays until the next write.

## Produced sources

Some resources get a value only once, in the response to their create. For example, Cloudflare returns the value of an API token only when it creates the token. Deploy can't ask such a resource for the value later, so the value can't come from a source such as `env`.

A resource like this is a producer. A producer exposes each such value as a produced source, at `<producer>.sources.<name>`. A secret takes the produced source as its `source`, without a `key`:

```ts [infra/tokens.ts]
import { secret } from "@notation/cloudflare/secrets-store";
import { accountToken } from "@notation/cloudflare/tokens";

export const deployToken = accountToken({ id: "deploy", policies });

// A second secret that holds the same token value.
export const ciToken = secret({
  id: "ci-token",
  source: deployToken.sources.value,
});
```

Deploy creates the resources in this order: the store, the producer, the secret, and then a Worker that binds the secret. The producer's create writes the value to each secret that takes the source. The secret's create writes nothing. It checks that the secret exists in the store, and records it.

- **Evaluation fails when no secret takes a produced source.** Only the producer's create gets the value, so without a secret the value would be lost. The error names the source, such as `No secret takes accountToken({ id: "deploy" }).sources.value.`
- **A change to the secrets that take a produced source replaces the producer.** The producer holds the list of secrets in an immutable param, because only a create gets a value to write to a new secret. The new producer writes a new value to every secret that takes the source, so the replace is a rotation. Plan prints the secrets under the producer's replace:

  ```text
  -/+ replace cloudflare/tokens/AccountToken token:deploy (delete, then create)
      rotation: writes a new value to the secrets deploy, ci-token
  ```

- **A write that fails is rolled back.** When the producer's create fails to write to one secret, it deletes the secrets that it wrote to before it. The rollback also deletes a secret with an explicit `name` that took the value, although destroy leaves such a secret. The token's create also deletes the new token. In a rotation, a secret that held the earlier value can then be empty. The error says so, and the next plan shows each empty secret as drift.
- **A secret deleted outside notation is drift.** The secret's read finds no secret with the name, and plan shows the secret as `drift-recreate`. Deploy then fails at the secret, because only the producer's create writes the value. The error says how to rotate the producer:

  ```text
  The secret shop--dev--deploy of `deploy` is missing. Only the create of its producer writes the value. To rotate accountToken({ id: "deploy" }), delete the API token shop--dev--deploy in the Cloudflare dashboard, then run `notation deploy`. Deploy creates a new token and writes its value to each secret that takes it.
  ```

- Destroy deletes the secret and its value, as for any secret named `<app>--<stage>--<id>`. The producer's delete removes only the producer's own resource, such as the API token, and leaves the secrets.
- When the producer is removed from the code and the secret stays, the secret keeps its last value. From then on, the secret takes its value from its new source. With no source, deploy finds that the secret exists and doesn't ask for a value.
- `notation secret set` and `notation secret delete` refuse a secret with a produced source. The message says how to rotate the producer.

### Rotating a producer

To rotate a producer, delete its remote resource outside notation, then deploy. For `accountToken({ id: "deploy" })`, the steps are:

1. Delete (or revoke) the API token `shop--dev--deploy` in the Cloudflare dashboard.
2. Run `notation deploy`. The token's read finds no token, so plan shows the token as `drift-recreate`, with the secrets that get a new value:

   ```text
   ± drift-recreate cloudflare/tokens/AccountToken token:deploy
       rotation: writes a new value to the secrets deploy, ci-token
   ```

3. The new token's create writes its value to each secret that takes `sources.value`. A secret that was also deleted is then found again, so its create succeeds.

**Changing the token's `id` is not a rotation of the same secrets.** The secret's name comes from the `id`, so a new `id` makes a new token and a new secret, and a missing secret under the old name stays missing.

## `accountToken(config)`

`accountToken` declares an account-owned API token, and a secret that holds the token's value. The token is a producer, and the secret takes its `sources.value`. So the token's create writes the value to the secret in the same step, and the value never reaches state. The token and the secret are both named `<app>--<stage>--<id>`, and the secret has the token's `id`.

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

| Option      | Description                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Keys the token in state, and names the token and its secret `<app>--<stage>--<id>`. Changing the id replaces both: deploy creates a new token and secret, and deletes the old ones.                             |
| `policies`  | What the token can do. Each policy has an `effect`, `allow` or `deny`, the names of its `permissionGroups` as the dashboard shows them, and the `resources` it applies to. A change updates the token in place. |
| `condition` | Optional. The client IP ranges, in CIDR notation, as `{ requestIp: { in, notIn } }`. Only clients in `in` may use the token, and clients in `notIn` may not. A change updates the token in place.               |

`accountToken` returns an `AccountTokenGroup`, with these fields:

| Field           | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `token`         | The `cloudflare/tokens/AccountToken` resource, with the ID `token:<id>`.                          |
| `secret`        | The secret that holds the value. Its resource has the ID `secret:<id>`.                           |
| `sources.value` | The token's value, as a [produced source](#produced-sources). Another `secret()` can take it too. |

- A change to the policies or the condition updates the token, which keeps its value.
- If the IP ranges or the policies are changed in the dashboard, deploy changes them back to the declaration.
- Plan looks up the ID of each permission group by its name, and compares the IDs with the token's. A name can belong to more than one group, one for each scope. Then the scope of the policy's `resources` picks the group: `com.cloudflare.api.account.<account id>` picks the account group, and `com.cloudflare.api.account.zone.<zone id>` picks the zone group. If the resources have more than one scope, plan fails and lists the groups. Give each scope its own policy.
- The token's secret follows the rules of [produced sources](#produced-sources). If the secret is deleted, plan shows drift and deploy fails. To rotate the token, delete it in the Cloudflare dashboard and run `notation deploy`, as in [Rotating a producer](#rotating-a-producer). A secret that starts to take `sources.value` also rotates the token.
- Destroy deletes the secret, then the token.
- `notation secret set` and `notation secret delete` refuse the token's secret.

### Upgrading from 0.20

In 0.20, the `AccountToken` resource wrote its value to the secret itself, and state had no record of the secret. The first deploy with a later version keeps the token and its value:

1. Plan compares the token's new param `ValueTargets` with the secret that 0.20 wrote to, so the token is a `noop`.
2. Plan shows the secret's record, `secret:<id>`, as a create. A Worker that binds the token shows as an update, because the secret's outputs are unknown until its create has run.
3. Deploy creates the record of the secret. The secret's create finds the secret that 0.20 wrote, and records it without a write.

## `secretsStore.bind(secret)`

`secretsStore.bind` binds a secret from `secret()` or a token from `accountToken()` to a Worker, as a Secrets Store binding. For a token, it binds the token's secret. A rotation that keeps the secret, such as one caused by a new secret that takes `sources.value`, writes the new value to the same secret, so the binding stays the same. A change to the token's `id` makes a new secret, so the binding changes. In the Worker, the binding has the type `SecretsStoreSecret`, and the code reads the value with `await env.NAME.get()`. The Worker is uploaded after the secret, because Cloudflare fails an upload that binds a secret that doesn't exist.

## The store

Cloudflare allows one Secrets Store for each account, and every app and stage in the account shares it. A declaration of a secret or a token adds the store as the resource `secrets-store`. Deploy adopts the account's store, or creates one named `default_secrets_store`, the name that the dashboard uses. Destroy leaves the store.

## Credentials

`CLOUDFLARE_API_TOKEN` needs these permissions, besides those in [Workers](workers.md#credentials):

- **Secrets Store: Edit**, for secrets and tokens.
- **Account API Tokens: Edit**, for `accountToken()`.
