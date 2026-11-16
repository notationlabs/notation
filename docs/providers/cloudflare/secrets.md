# Secrets

`@notation/cloudflare/resources` declares the account's [Secrets Store](https://developers.cloudflare.com/secrets-store/), the secrets in it, and account-owned API tokens. A secret takes its value from a [credential](../../manual/secrets.md#credentials): the value of a source, such as an environment variable, or the value of a token. Notation records where a secret is, such as the store ID and the name. It never records the secret's value.

| Class                             | Type                                           |
| --------------------------------- | ---------------------------------------------- |
| `secretsStore.SecretsStore`       | `cloudflare/secrets-store/SecretsStore`        |
| `secretsStore.SecretsStoreSecret` | `cloudflare/secrets-store/SecretsStoreSecret`  |
| `tokens.AccountToken`             | `cloudflare/tokens/AccountToken`               |

A Worker can also hold a secret of its own, which it binds as a string. See [Worker secrets](workers.md#worker-secrets).

## `secretsStore.SecretsStore`

Cloudflare allows one Secrets Store for each account, and every app and stage in the account shares it. Declare it once, and pass it to each secret as a dependency:

```ts [infra/secrets.ts]
import { secretsStore } from "@notation/cloudflare/resources";

export const store = new secretsStore.SecretsStore("store");
```

- The store takes no config. Its `AccountId` is `CLOUDFLARE_ACCOUNT_ID`.
- Deploy adopts the account's store, or creates one named `default_secrets_store`, the name that the dashboard uses.
- Destroy leaves the store, as other apps and stages may use it.

## `secretsStore.SecretsStoreSecret`

A store secret holds the value of one credential. The Stripe key from the environment variable `STRIPE_KEY`:

::code-group

```ts [infra/secrets.ts]
import { secretsStore } from "@notation/cloudflare/resources";
import { sources } from "@notation/std/resources";

export const store = new secretsStore.SecretsStore("store");

const stripeKey = new sources.Env("stripe-key", {
  config: { key: "STRIPE_KEY" },
});

export const stripeKeySecret = new secretsStore.SecretsStoreSecret(
  "stripe-key-secret",
  {
    config: { Value: stripeKey.credentials.value },
    dependencies: { store },
  },
);
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { stripeKeySecret } from "../infra/secrets";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ STRIPE_KEY: stripeKeySecret }),
});

export default {
  async fetch(request, env) {
    const key = await env.STRIPE_KEY.get();
    return new Response(key ? "configured" : "missing");
  },
} satisfies WorkerHandler<typeof worker>;
```

::

| Config  | Description                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------- |
| `Value` | Required. A credential of another resource, such as `stripeKey.credentials.value` or `token.credentials.Value`. |

| Dependency | Description                       |
| ---------- | --------------------------------- |
| `store`    | The account's `SecretsStore`.     |

**Deploy generates the secret's name**, `<app>--<stage>--<id>-<instance>`, where the instance is 8 random hex characters, such as `orders--prod--stripe-key-secret-3fa91c02`. A name is cut to 255 characters, the most that Cloudflare accepts. Config cannot set the name, so a secret that exists cannot be adopted, and one secret cannot be shared between stages.

- Create writes the value. A new secret gets the scope Workers. If a secret with the name exists, as after a create whose outcome was unknown, create sets its value.
- Update writes the value only when the credential has a new version. See [When a value is written](../../manual/secrets.md#when-a-value-is-written). A secret whose source is an `Env` without `track` is written on every deploy.
- Read finds the secret by its name. A secret deleted outside Notation is seen as drift, and the next deploy creates it again with the value of the credential.
- Cloudflare never returns a secret's value, so a value changed in the dashboard or with wrangler isn't seen as a change. It stays until the next write.
- Destroy, and the removal of the secret from code, delete the secret.

### Binding a store secret

A Worker binds a `SecretsStoreSecret` instance directly, as above. In the handler, the binding has the type `SecretsStoreSecret`, and the code reads the value with `await env.STRIPE_KEY.get()`. The Worker depends on the secret, so the secret exists before the code is uploaded. Cloudflare fails an upload that binds a secret that doesn't exist.

Several Workers can bind one store secret. To give one Worker the value as a string instead, bind the credential itself. See [Worker secrets](workers.md#worker-secrets).

## `tokens.AccountToken`

`AccountToken` declares an account-owned API token. Its value is the credential `Value`. Cloudflare returns the value only when it creates the token and when it rolls it. To keep the value, send it to a store secret:

::code-group

```ts [infra/tokens.ts]
import { secretsStore, tokens } from "@notation/cloudflare/resources";
import { store } from "./secrets";

const deployToken = new tokens.AccountToken("deploy-token", {
  config: {
    Policies: [
      {
        effect: "allow",
        permissionGroups: ["Workers Scripts Write"],
        resources: { "com.cloudflare.api.account.<account id>": "*" },
      },
    ],
  },
});

export const deployTokenSecret = new secretsStore.SecretsStoreSecret(
  "deploy-token-secret",
  {
    config: { Value: deployToken.credentials.Value },
    dependencies: { store },
  },
);
```

```ts [runtime/ci.ts]
import { $worker } from "@notation/cloudflare/workers";
import { deployTokenSecret } from "../infra/tokens";

export const worker = $worker({
  id: "ci",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ DEPLOY_TOKEN: deployTokenSecret }),
});
```

::

| Config      | Description                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Policies`  | Required. What the token can do. Each policy has an `effect`, `allow` or `deny`, the names of its `permissionGroups` as the dashboard shows them, and the `resources` it applies to. A change updates the token in place. |
| `Condition` | Optional. The client IP ranges, in CIDR notation, as `{ requestIp: { in, notIn } }`. Only clients in `in` may use the token, and clients in `notIn` may not. A change updates the token in place.               |
| `ExpiresOn` | Optional. The time from which Cloudflare rejects the token, in ISO 8601 in UTC, such as `2027-01-01T00:00:00Z`. Use a fixed time: a time computed at deploy changes on every deploy, so every deploy updates the token. |
| `NotBefore` | Optional. The time before which Cloudflare rejects the token.                                                                                                                                                  |

Deploy names the token `<app>--<stage>--<id>-<instance>`, cut to 120 characters. Config cannot set the name.

- The value goes from the token to the secret in memory, and never reaches state. See [Credentials](../../reference/resource.md#credentials).
- A change to the policies, the condition or the times updates the token, which keeps its value.
- If the IP ranges or the policies are changed in the dashboard, deploy changes them back to the config.
- Plan looks up the ID of each permission group by its name, and compares the IDs with the token's. A name can belong to more than one group, one for each scope. Then the scope of the policy's `resources` picks the group: `com.cloudflare.api.account.<account id>` picks the account group, and `com.cloudflare.api.account.zone.<zone id>` picks the zone group. If the resources have more than one scope, plan fails and lists the groups. Give each scope its own policy.
- Destroy deletes the token.

**Deploy rolls the token when a resource needs its value and deploy holds none.** The token keeps its ID and gets a new value, and Cloudflare rejects the old one. Deploy then updates every resource that takes the value. This happens when an earlier deploy created the token and failed before it wrote the secret, when a second secret takes the value in a later deploy, and when drift detection finds that the secret is gone. If a write of a secret then fails, that secret holds a value that Cloudflare rejects until a deploy succeeds. Plan shows the roll:

```text
~ rotate cloudflare/tokens/AccountToken deploy-token
    Value gets a new value, as a resource that takes it needs one
```

## Credentials

`CLOUDFLARE_API_TOKEN` needs these permissions, besides those in [Workers](workers.md#credentials):

- **Secrets Store: Edit**, for the store and its secrets.
- **Account API Tokens: Edit**, for `AccountToken`.
