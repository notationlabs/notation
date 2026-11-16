# Infisical

`@notation/infisical/resources` exports `InfisicalSecret`, a [source](../../manual/secrets.md#sources) that reads one secret from [Infisical](https://infisical.com). Its credential, `value`, is the secret's value, which another resource takes as `source.credentials.value`.

```sh
npm install @notation/infisical
```

## `InfisicalSecret`

The Stripe key of the `orders` service, written to the Cloudflare Secrets Store:

```ts [infra/secrets.ts]
import { secretsStore } from "@notation/cloudflare/resources";
import { deployment } from "@notation/core";
import { InfisicalSecret } from "@notation/infisical/resources";

const { stage } = deployment();
const store = new secretsStore.SecretsStore("store");

const stripeKey = new InfisicalSecret("stripe-key", {
  config: {
    projectId: "4f2a…",
    environment: stage === "prod" ? "prod" : "dev",
    path: "/orders",
    key: "STRIPE_KEY",
  },
});

new secretsStore.SecretsStoreSecret("stripe-key-secret", {
  config: { Value: stripeKey.credentials.value },
  dependencies: { store },
});
```

| Config        | Description                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `projectId`   | Required. The ID of the Infisical project.                                                                        |
| `environment` | Required. The environment's slug, such as `prod`. To pick it by stage, use [`deployment()`](../../manual/secrets.md#a-value-that-depends-on-the-stage). |
| `path`        | Required. The folder of the secret, such as `/orders`.                                                            |
| `key`         | Required. The secret's key.                                                                                       |
| `track`       | Optional. `"scrypt"` or `"hmac"`. See [Tracking a value](../../manual/secrets.md#tracking-a-value).                |

`INFISICAL_DOMAIN` sets the URL of the Infisical instance. It defaults to `https://app.infisical.com`.

- The source reads a shared secret in the folder. A secret imported into the folder, and a personal override, are not read.
- Plan and deploy fail when the folder doesn't have the key, when the identity can't read secret values, and when the value is empty.
- Plan reads the value of every `InfisicalSecret`, so the identity that runs plan needs permission to read values. Plan keeps the value in memory, and does not record it.

## When the value is written

Without `track`, the `revision` of the source is the secret's ID and its Infisical version, such as `9c2e…:14`. A resource that takes the value is written when the version changes:

```text
~ update infisical/secrets/InfisicalSecret stripe-key
~ update cloudflare/secrets-store/SecretsStoreSecret stripe-key-secret
```

Deploy loads the value at the version in the `revision`, so every resource that takes the value gets the same value, even when the secret is edited during the deploy. The ID is in the `revision` because Infisical numbers a secret that is deleted and added again from 1. If the secret was deleted and added again after plan read it, deploy fails:

```text
`STRIPE_KEY` in Infisical project 4f2a…, environment prod, path /orders was deleted and added again after deploy read it. Run deploy again.
```

Some projects keep only the newest versions of a secret. When the version in the `revision` is gone, deploy fails, and the next plan records the current version.

### Secrets that refer to other secrets

A secret can refer to another secret:

```text
DB_PASSWORD   = correct-horse                                      version 4
DATABASE_URL  = postgres://app:${DB_PASSWORD}@db.internal/orders   version 14
```

When `DB_PASSWORD` changes, Infisical leaves `DATABASE_URL` at version 14. So for a secret with a reference, an unchanged version does not mean an unchanged value, and the source cannot use the version.

| `track` | The secret          | `revision`                 | A resource that takes the value is written |
| ------- | ------------------- | -------------------------- | ------------------------------------------ |
| not set | has no reference    | the secret's ID and version | when the version changes                   |
| not set | has a reference     | the deploy's execution ID  | on every deploy                            |
| set     | either              | a hash of the value        | when the value changes                     |

To find out whether a secret has a reference, plan reads the secret twice: once as it is stored, and once with each reference replaced by the value that it names. The two values differ exactly when the secret has a reference. Infisical replaces the references, so every form of reference works, including a reference to another environment or another project.

**Without `track`, a secret with a reference is written on every deploy,** and every plan shows the two updates above. When someone adds a reference to a secret in Infisical, that secret is written on every deploy from then on. This is the sign to add `track`:

```ts [infra/secrets.ts]
new InfisicalSecret("database-url", {
  config: {
    projectId: "4f2a…",
    environment: "prod",
    path: "/orders",
    key: "DATABASE_URL",
    track: "hmac",
  },
});
```

With `track`, plan reads the value with each reference replaced, and records a hash of it. The hash changes when `DATABASE_URL` is edited, and when any secret that it refers to is edited. With `track`, the source always uses the hash, even for a secret with no reference, so the config alone says how the secret is tracked. A secret with no reference does not need `track`, because its version already changes exactly when its value does.

## Credentials

`InfisicalSecret` logs in with the first of these that is set:

| Variables                                                                         | Login                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INFISICAL_TOKEN`                                                                 | An access token, used as it is.                                                                                                                              |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | A machine identity's client ID and secret, through [universal auth](https://infisical.com/docs/documentation/platform/identities/universal-auth).            |
| `INFISICAL_IDENTITY_ID`                                                           | A machine identity that uses [OIDC auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth/general), with the CI platform's OIDC token. |

With `INFISICAL_IDENTITY_ID`, the OIDC token is `INFISICAL_JWT` if it is set. Otherwise, in GitHub Actions, the source requests a token from GitHub. The job needs the permission `id-token: write`:

```yaml [.github/workflows/deploy.yml]
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      INFISICAL_IDENTITY_ID: ${{ vars.INFISICAL_IDENTITY_ID }}
    steps:
      - uses: actions/checkout@v4
      - run: npx notation deploy --stage prod
```

GitHub sets the token's audience to the URL of the repository's owner, such as `https://github.com/octo-org`, which is what [Infisical's GitHub guide](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github) puts in the identity's audiences. Set `INFISICAL_OIDC_AUDIENCE` to request another audience.

On another CI platform, put its OIDC token in `INFISICAL_JWT`. In GitLab CI, for example:

```yaml [.gitlab-ci.yml]
deploy:
  id_tokens:
    INFISICAL_JWT:
      aud: https://gitlab.com
  variables:
    INFISICAL_IDENTITY_ID: "…"
  script:
    - npx notation deploy --stage prod
```
