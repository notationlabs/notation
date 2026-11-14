---
"@notation/infisical": minor
---

New package, part 3 of RFC 0017. `infisical({ projectId, environment, path })` from `@notation/infisical/sources` gives secrets their values from one folder of an Infisical project.

- `environment` is an environment slug, or a function of the stage that returns one. `path` defaults to `/`. `siteUrl` defaults to `INFISICAL_DOMAIN`, and then to `https://app.infisical.com`.
- The source lists the folder once in each plan or deploy, through `GET /api/v4/secrets`, and answers every key from that response. Secret references are expanded. Imported secrets, subfolders and personal overrides aren't read.
- A key's version is the secret's ID and its Infisical version, so a secret is written to its store when it changes in Infisical. A secret whose value references another secret has no version, because its Infisical version doesn't change when the referenced secret changes. It is written on every deploy, like a secret from `env` or `dotenv`.
- It logs in with `INFISICAL_TOKEN`, or with `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` through universal auth, or with `INFISICAL_IDENTITY_ID` through OIDC auth. The OIDC token is `INFISICAL_JWT`, or a token requested from GitHub Actions. `INFISICAL_OIDC_AUDIENCE` sets the audience of GitHub's token.
