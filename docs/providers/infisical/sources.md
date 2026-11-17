# Infisical

Sync secrets from Infisical into AWS, Cloudflare, or custom Notation resources at deploy time. Secret values stay out of state, plans, and error output while upstream changes still trigger downstream updates.

## Installation

Install `@notation/infisical` alongside `@notation/core` and your cloud provider package:

```sh [Terminal]
@pm.add("@notation/infisical")
```

## Quickstart

Declare `InfisicalSecret` from `@notation/infisical/resources` in an infrastructure module, then pass `.credentials.value` to an AWS Lambda function or a Cloudflare Worker:

::code-group

```ts [infra/secrets.ts]
import { deployment } from "@notation/core";
import { InfisicalSecret } from "@notation/infisical/resources";

export const stripeKey = new InfisicalSecret("stripe-key", {
  config: {
    projectId: process.env.INFISICAL_PROJECT_ID!,
    environment: deployment().stage,
    path: "/orders",
    key: "STRIPE_KEY",
  },
});
```

```ts [runtime/create-order.ts]
import {
  $lambda,
  apiGateway,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { stripeKey } from "../infra/secrets";
import { NewOrder } from "../shared/schema";

export const createOrder = $lambda({
  id: "create-order",
  event: () => apiGateway.schema(NewOrder),
  env: () => ({
    STRIPE_KEY: stripeKey.credentials.value,
  }),
});

export const handler: LambdaHandler<typeof createOrder> = async (event) => {
  const { body: order } = await createOrder.decode(event);
  const { STRIPE_KEY } = createOrder.env();
  return {
    statusCode: 202,
    body: JSON.stringify({ orderId: order.orderId, configured: Boolean(STRIPE_KEY) }),
  };
};
```

```ts [runtime/orders.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { stripeKey } from "../infra/secrets";

export const ordersWorker = $worker({
  id: "orders",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    STRIPE_KEY: stripeKey.credentials.value,
  }),
});

export default {
  async fetch(_request, env) {
    return Response.json({ configured: Boolean(env.STRIPE_KEY) });
  },
} satisfies WorkerHandler<typeof ordersWorker>;
```

::

`deployment().stage` maps each Notation stage to an Infisical environment slug, and `.credentials.value` binds directly into AWS [`$lambda`](../aws/lambda.md) `env` or Cloudflare [`$worker`](../cloudflare/workers.md) `bindings`.

## Cloudflare Secrets Store

When multiple Workers need the same shared secret, pass `InfisicalSecret.credentials.value` into Cloudflare [`SecretsStoreSecret`](../cloudflare/secrets.md) and bind the store secret to each Worker:

::code-group

```ts [infra/secrets.ts]
import { deployment } from "@notation/core";
import { secretsStore } from "@notation/cloudflare/resources";
import { InfisicalSecret } from "@notation/infisical/resources";

const store = new secretsStore.SecretsStore("account-store");

const webhookSource = new InfisicalSecret("webhook-secret-source", {
  config: {
    projectId: process.env.INFISICAL_PROJECT_ID!,
    environment: deployment().stage,
    path: "/orders",
    key: "WEBHOOK_SECRET",
  },
});

export const webhookSecret = new secretsStore.SecretsStoreSecret(
  "webhook-secret",
  {
    config: { Value: webhookSource.credentials.value },
    dependencies: { store },
  },
);
```

```ts [runtime/webhooks.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { webhookSecret } from "../infra/secrets";

export const webhooksWorker = $worker({
  id: "webhooks",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    WEBHOOK_SECRET: webhookSecret,
  }),
});

export default {
  async fetch(_request, env) {
    const signingKey = await env.WEBHOOK_SECRET.get();
    return Response.json({ configured: Boolean(signingKey) });
  },
} satisfies WorkerHandler<typeof webhooksWorker>;
```

::

## Authentication

`@notation/infisical` authenticates with Infisical in a fixed precedence order during `plan` and `deploy`:

1. **Access token (`INFISICAL_TOKEN`)** – Used directly as a `Bearer` token.
2. **Universal Auth (`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`, `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`)** – Exchanges a client ID and secret for a token (both must be set).
3. **OIDC Auth (`INFISICAL_IDENTITY_ID`)** – Exchanges `INFISICAL_JWT` or a GitHub Actions `id-token: write` token (with optional `INFISICAL_OIDC_AUDIENCE`).

If no valid credential set is configured, Notation fails with the required environment variable names.

Configure GitHub Actions OIDC authentication by granting `id-token: write` and exporting `INFISICAL_IDENTITY_ID`:

```yaml [.github/workflows/deploy.yml]
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - run: notation deploy --stage prod
        env:
          INFISICAL_IDENTITY_ID: ${{ vars.INFISICAL_IDENTITY_ID }}
          INFISICAL_PROJECT_ID: ${{ vars.INFISICAL_PROJECT_ID }}
```

## Self-hosted instances

Set `INFISICAL_DOMAIN` to point `@notation/infisical` at a self-hosted Infisical instance instead of Infisical Cloud (`https://app.infisical.com`):

```sh [Terminal]
export INFISICAL_DOMAIN="https://vault.example.com/api/"
```

Notation strips trailing slashes and any trailing `/api` segment while keeping subpath prefixes such as `https://example.com/infisical`.

## Tracking secret references

When a secret in Infisical interpolates another secret (such as `postgres://app:${DB_PASSWORD}@db:5432/orders`), Infisical does not bump the parent secret's version when `${DB_PASSWORD}` changes. Without `track`, Notation must update downstream consumers on every deploy to keep referenced values fresh.

Set `track: "hmac"` to hash the final expanded value so downstream consumers update only when the resolved secret actually changes:

```ts [infra/secrets.ts]
import { InfisicalSecret } from "@notation/infisical/resources";

export const dbUrl = new InfisicalSecret("orders-database-url", {
  config: {
    projectId: process.env.INFISICAL_PROJECT_ID!,
    environment: "prod",
    path: "/orders",
    key: "DATABASE_URL",
    track: "hmac",
  },
});
```

Export the same `NOTATION_TRACK_KEY` on every machine and CI runner that executes `plan` or `deploy` with `track: "hmac"`:

```sh [Terminal]
export NOTATION_TRACK_KEY="your-shared-track-key"
```

`track: "hmac"` also stabilizes secrets imported into `path` from another folder or environment, because Infisical does not pin versions on imported secrets.

## Reference

### InfisicalSecret

`InfisicalSecret` (`infisical/secrets/InfisicalSecret`) from `@notation/infisical/resources` declares a read-only credential source resource.

#### Parameters

Every `InfisicalSecret` accepts these `config` parameters (all required `string` values except optional `track`):

| Parameter | Description |
| :--- | :--- |
| `projectId` | Infisical project ID containing the secret |
| `environment` | Infisical environment slug such as `"dev"`, `"prod"`, or `deployment().stage` |
| `path` | Normalized folder path inside the environment such as `"/"` or `"/orders"` |
| `key` | Secret key name in Infisical |
| `track` | `"hmac"` or `"scrypt"` mode that hashes expanded values instead of pinning versions |

#### Properties

Each `InfisicalSecret` instance exposes:

- **`revision`** (`string`, computed output) – Opaque revision string stored in Notation state without plaintext.
- **`credentials.value`** (`CredentialRef<string>`, credential) – Typed [credential reference](../../core/secrets.md) passed to downstream consumer resources.

#### Secret scope

`InfisicalSecret` reads only shared secrets (`type: "shared"`) so personal overrides never leak into shared deployments, and resolves secrets imported into `path`. As a read-only credential source, it never writes to Infisical, cannot be targeted with `--replace`, and removing it from code deletes only its Notation state record.

### Change tracking modes

`InfisicalSecret` queries Infisical live on every `plan` and `deploy`, updating downstream consumers only when `revision` or source parameters change:

| Mode | Behavior |
| :--- | :--- |
| `undefined` | Pins secret ID and version on static secrets, or re-deploys on every run for `${...}` references |
| `"hmac"` | Compares a salted HMAC-SHA256 digest of the expanded value using `NOTATION_TRACK_KEY` |
| `"scrypt"` | Compares a salted scrypt digest of the expanded value with no external key |

Use `"hmac"` for arbitrary secrets, `${...}` references, and imported secrets (`NOTATION_TRACK_KEY` must be set), and use `"scrypt"` only for high-entropy generated secrets. Leaving `track` unset on `${...}` references fetches the live expanded value on resume, so consumers updated before and after a mid-deploy edit can receive different values. If an expanded value changes mid-deploy or `track` changes relative to state, `deploy` aborts cleanly and prompts you to re-run.

### Errors

`@notation/infisical/resources` exports `SecretReplacedError` and `InfisicalApiError`:

- **`SecretReplacedError`** – Thrown when a secret is deleted and recreated mid-deploy; re-running `deploy` picks up the new secret.
- **`InfisicalApiError`** – Thrown on non-OK API responses other than handled cases, exposing `.status` and the response message.

Missing (`404`) or empty (`""`) secrets throw an error naming the missing key and path, hidden secret values fail with instructions to grant read permissions, and secret values are scrubbed from error messages and stack traces.
