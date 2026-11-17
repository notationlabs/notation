# Secrets

Manage Cloudflare Secrets Store entries and account API tokens in TypeScript, wiring credentials into [Workers](./workers.md) and [Containers](./containers.md) without storing plaintext in state, plans, or bundles.

Grant `CLOUDFLARE_API_TOKEN` **Secrets Store: Edit** for `SecretsStore` and `SecretsStoreSecret`, and **Account API Tokens: Edit** for `AccountToken` (see [Cloudflare Overview](./overview.md)).

## Choosing a secret type

Cloudflare provides three ways to supply credentials, all keeping plaintext out of state, plans, and bundles (see [Secrets](../../core/secrets.md)):

- **Worker secrets (`secret_text`)** – Pass a credential directly in Worker `bindings()` (such as `source.credentials.value`). Typed as `string` in `env` for synchronous reads via `env.NAME`; best for single-Worker credentials.
- **Secrets Store (`secrets_store_secret`)** – Store a credential in `SecretsStore` using `SecretsStoreSecret` and bind the resource to one or more Workers. Typed as `SecretsStoreSecret` in `env` for asynchronous reads via `await env.NAME.get()`; best for shared or independently rotated secrets.
- **Account tokens (`AccountToken`)** – Provision scoped Cloudflare API tokens with permission policies, IP filters, and expiry timestamps, then pass `token.credentials.Value` into a Worker secret or a `SecretsStoreSecret`.

Declare a direct Worker secret, a shared `SecretsStoreSecret`, and an `AccountToken`, then read all three inside one Worker:

::code-group

```ts [infra/secrets.ts]
import { secretsStore, tokens } from "@notation/cloudflare/resources";
import { sources } from "@notation/std/resources";

export const store = new secretsStore.SecretsStore("account-store");

export const stripeKey = new sources.Env("stripe-key", {
  config: { key: "STRIPE_KEY", track: "hmac" },
});

export const webhookSecret = new secretsStore.SecretsStoreSecret(
  "webhook-secret",
  {
    config: { Value: stripeKey.credentials.value },
    dependencies: { store },
  },
);

export const deployToken = new tokens.AccountToken("deploy-token", {
  config: {
    Policies: [
      {
        effect: "allow",
        permissionGroups: ["Workers Scripts Write"],
        resources: {
          [`com.cloudflare.api.account.${process.env.CLOUDFLARE_ACCOUNT_ID!}`]:
            "*",
        },
      },
    ],
  },
});
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { deployToken, stripeKey, webhookSecret } from "../infra/secrets";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    STRIPE_KEY: stripeKey.credentials.value,
    WEBHOOK_SECRET: webhookSecret,
    DEPLOY_TOKEN: deployToken.credentials.Value,
  }),
});

export default {
  async fetch(_request, env) {
    const sharedSecret = await env.WEBHOOK_SECRET.get();
    return Response.json({
      hasStripeKey: Boolean(env.STRIPE_KEY),
      hasSharedSecret: Boolean(sharedSecret),
      hasDeployToken: Boolean(env.DEPLOY_TOKEN),
    });
  },
} satisfies WorkerHandler<typeof api>;
```

::

## Secrets Store

Cloudflare permits **one Secrets Store per account**, shared across every application and stage in that account. Instantiate `secretsStore.SecretsStore` with no configuration – Notation derives `AccountId` from `CLOUDFLARE_ACCOUNT_ID`, adopts your existing store or creates one, and leaves the shared store intact when [`notation destroy`](../../cli/destroy.md) removes a stage's `SecretsStoreSecret` entries.

### Secret updates

`SecretsStoreSecret` records only a version marker in state and updates Cloudflare only when the source credential's version changes. Manual edits to a secret's value in the Cloudflare dashboard are not detected as drift because Cloudflare never returns secret values on read, while externally deleted secrets appear missing in `notation plan` and recreate on deploy.

### Container registries

`containers.ContainerRegistry` binds a `SecretsStore` using `store.outputRef("StoreId")` in `Auth.private_credential.store_id`:

```ts [infra/registry.ts]
import { containers, secretsStore } from "@notation/cloudflare/resources";

const store = new secretsStore.SecretsStore("account-store");

export const ecrRegistry = new containers.ContainerRegistry("ecr-registry", {
  config: {
    Domain: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    Kind: "ECR",
    Auth: {
      public_credential: process.env.ECR_PULL_ACCESS_KEY_ID!,
      private_credential: {
        store_id: store.outputRef("StoreId"),
        secret_name: "orders-ecr-pull-secret",
      },
    },
  },
});
```

`SecretsStoreSecret` creates `"workers"`-scoped secrets, whereas container registries require `"containers"` scope. Provision registry pull secrets externally with `"containers"` scope and pass `secret_name` alongside `store.outputRef("StoreId")` (see [Containers](./containers.md)).

## Account tokens

`tokens.AccountToken` provisions an account-owned Cloudflare API token with permission policies, optional CIDR IP filters, and optional validity timestamps.

Configure `Policies`, `Condition`, `ExpiresOn`, and `NotBefore`, then pass `token.credentials.Value` to a `SecretsStoreSecret` or Worker binding:

```ts [infra/tokens.ts]
import { secretsStore, tokens } from "@notation/cloudflare/resources";

export const store = new secretsStore.SecretsStore("account-store");

export const ordersDeployToken = new tokens.AccountToken("orders-deploy-token", {
  config: {
    Policies: [
      {
        effect: "allow",
        permissionGroups: ["Workers Scripts Write"],
        resources: {
          [`com.cloudflare.api.account.${process.env.CLOUDFLARE_ACCOUNT_ID!}`]:
            "*",
        },
      },
    ],
    Condition: {
      requestIp: {
        in: ["198.51.100.0/24"],
        notIn: ["198.51.100.99/32"],
      },
    },
    ExpiresOn: "2028-01-01T00:00:00Z",
    NotBefore: "2026-01-01T00:00:00Z",
  },
});

export const ordersDeployTokenSecret = new secretsStore.SecretsStoreSecret(
  "orders-deploy-token-secret",
  {
    config: { Value: ordersDeployToken.credentials.Value },
    dependencies: { store },
  },
);
```

Keep these operational behaviors in mind when using `AccountToken`:

- **In-place policy updates** – Changing `Policies`, `Condition`, `ExpiresOn`, or `NotBefore` updates the existing token in place while preserving its `TokenId` and `Value`; omitting `Condition`, `ExpiresOn`, or `NotBefore` clears those fields.
- **Fixed timestamps** – Always pass fixed ISO 8601 UTC timestamps rather than `new Date(...)`, which would update the token on every deploy.
- **Automatic rotation** – Cloudflare returns `Value` only on creation and rotation. When a new deploy process needs the value (for new consumers, recreated secrets, or resumed deploys), Notation rolls the token, invalidating the old value and updating every consumer.
- **Manual replacement** – `notation deploy --credential` rejects `AccountToken` because `AccountToken` rotates automatically.

To force a brand-new `TokenId` and generated `Name` on an `AccountToken`, preview and apply `--replace`:

```sh [Terminal]
notation plan --replace orders-deploy-token
notation deploy --replace orders-deploy-token@<instanceHash>
```

## Reference

### Credential references

Notation separates secret references from plain outputs so secret values never enter state or derived expressions (see [Types](../../core/types.md)):

- **`CredentialRef<string>` (`kind: "credential"`)** – Returned by `producer.credentials.<key>` and passed whole into secret-accepting fields; `outputRef()`, `text`, `.map()`, and `all()` reject it.
- **`OutputRef<string>` (`kind: "output"`)** – Returned by `resource.outputRef(key)` for non-secret outputs such as `StoreId` or `TokenId`, compatible with `text`, `.map()`, and `all()`.

### `SecretsStore`

`secretsStore.SecretsStore` (`cloudflare/secrets-store/SecretsStore`) from `@notation/cloudflare/resources` takes no `config` fields:

| Property | Description |
| :--- | :--- |
| `AccountId` | Derived immutable `string` from `CLOUDFLARE_ACCOUNT_ID` |
| `StoreId` | Computed `string` adopted or created store ID |

Reference `StoreId` via `.outputRef("StoreId")`. Creation adopts an existing account store or creates `default_secrets_store`, and deletion is a no-op so shared stages stay unaffected.

### `SecretsStoreSecret`

`secretsStore.SecretsStoreSecret` (`cloudflare/secrets-store/SecretsStoreSecret`) from `@notation/cloudflare/resources` requires `dependencies: { store }`:

| Property | Description |
| :--- | :--- |
| `Value` | Required sensitive `CredentialRef<string>` secret value |
| `Name` | Generated physical name `<app>--<stage>--<id>-<instance>` |
| `SecretId` | Computed `string` store secret ID assigned by Cloudflare |
| `StoreId` | Derived `string` store ID from `dependencies.store` |
| `AccountId` | Derived `string` account ID from `dependencies.store` |

`Value` accepts a credential reference from `@notation/std/resources`, [Infisical](../infisical/sources.md), or `AccountToken`. `Name` is capped at 255 characters (see [Physical Names](../../core/physical-names.md)).

Secrets are created with `scopes: ["workers"]`. Deletion matches by physical `Name` and succeeds quietly if the secret or store is already gone.

### `AccountToken`

`tokens.AccountToken` (`cloudflare/tokens/AccountToken`) from `@notation/cloudflare/resources` manages account-owned API tokens:

| Property | Description |
| :--- | :--- |
| `Name` | Generated immutable physical name `<app>--<stage>--<id>-<instance>` |
| `AccountId` | Derived immutable `string` from `CLOUDFLARE_ACCOUNT_ID` |
| `TokenId` | Computed `OutputRef<string>` Cloudflare token ID |
| `credentials.Value` | Sensitive `CredentialRef<string>` token secret passed to consumers |

`Name` is capped at 120 characters (see [Physical Names](../../core/physical-names.md)).

#### Policies

`Policies` is a non-empty array of policy objects:

| Property | Description |
| :--- | :--- |
| `effect` | Policy effect, `"allow"` or `"deny"` |
| `permissionGroups` | Non-empty array of exact Cloudflare permission group names |
| `resources` | Map of Cloudflare resource scopes to `"*"` or nested scopes |

Use exact permission group names from the Cloudflare dashboard, such as `"Workers Scripts Write"` or `"Account Settings Read"`. Map scopes using `{ [`com.cloudflare.api.account.${accountId}`]: "*" }` for account scope or `{ [`com.cloudflare.api.account.${accountId}`]: { "com.cloudflare.api.account.zone.*": "*" } }` for zone scope.

Notation uses `resources` to disambiguate permission group names that exist at multiple scopes (such as `"Logs Write"`). Split ambiguous multi-scope entries into separate objects in `Policies`.

#### Conditions

`Condition` accepts `{ requestIp?: { in?: string[]; notIn?: string[] } }` containing CIDR strings, `OutputRef<string>`, or `Derived<string>`. Ranges are sorted and normalized so list order never triggers updates.

#### Lifetimes

`ExpiresOn` and `NotBefore` accept ISO 8601 UTC timestamps (`YYYY-MM-DDTHH:MM:SSZ` or `.sssZ`), normalized to whole seconds.

#### Token drift

External dashboard edits to `Policies` or `Condition.requestIp` appear as drift and reconcile on deploy. Removed `ExpiresOn` or `NotBefore` values and disabled token statuses are not checked as drift; deleted tokens recreate and rotate across every consumer. Replacement creates the new token, updates all consumers, and deletes the old token at the end of deploy.
