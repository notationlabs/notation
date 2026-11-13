# Infisical

`@notation/infisical` gives secrets their values from [Infisical](https://infisical.com). It exports the source `infisical()` from `@notation/infisical/sources`. See [Secrets](../../manual/secrets.md) for how a secret uses a source.

```sh
npm install @notation/infisical
```

## `infisical(options)`

`infisical()` reads one folder of an Infisical project:

```ts [infra/secrets.ts]
import { secret } from "@notation/cloudflare/secrets-store";
import { infisical } from "@notation/infisical/sources";

const vault = infisical({
  projectId: "4f2a…",
  environment: (stage) => (stage === "prod" ? "prod" : "dev"),
  path: "/orders",
});

export const stripeKey = secret({
  id: "stripe-key",
  source: vault,
  key: "STRIPE_KEY",
});
```

| Option        | Description                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `projectId`   | The ID of the Infisical project.                                                                            |
| `environment` | The environment's slug, such as `dev`, or a function that takes the stage and returns the slug.             |
| `path`        | The folder to read. Defaults to `/`.                                                                        |
| `siteUrl`     | The URL of the Infisical instance. Defaults to `INFISICAL_DOMAIN`, and then to `https://app.infisical.com`. |

- The source lists the folder's secrets once in each plan or deploy, and answers every key from that one response. `notation watch` lists the folder again on each deploy.
- Secret references in values are expanded. Secrets imported into the folder, secrets in its subfolders, and personal overrides aren't read.
- The version of a key is the secret's ID and its Infisical version, such as `9c41…:14`. A secret is written to its store when the version changes. The ID is part of the version because a secret that is deleted and added again starts again at version 1.
- Plan and deploy fail when the folder doesn't have the key, and deploy fails when the identity can't read secret values.

## Credentials

The source logs in with the first of these that is set:

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
