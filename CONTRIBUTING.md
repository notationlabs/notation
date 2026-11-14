# Contributing

Every task in this repository runs through `pok`. Run `pok` on its own to list
the commands, or `pok <command> --help` for one of them.

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pok build`      | Build every package                                                 |
| `pok dev`        | Watch and rebuild every package                                     |
| `pok test run`   | Run the suite once, as CI and the pre-commit hook do                |
| `pok test watch` | Re-run tests on change                                              |
| `pok test e2e`   | Build, then run the end-to-end tests against real provider accounts |
| `pok typecheck`  | Type-check every package                                            |
| `pok format`     | Format the repository                                               |

## Tests

The tests of a provider mirror its source. Each resource or construct has two
files side by side, such as `test/resources/workers/worker-script.test.ts` and
`test/resources/workers/worker-script.e2e.test.ts`:

- `<name>.test.ts` holds the unit tests. They mock the provider's API, and
  `pok test run` runs them.
- `<name>.e2e.test.ts` holds the end-to-end tests. They write a project to a
  temp directory, run the built CLI's `deploy` and `destroy` in it, and check
  the result in a real account with the provider. `pok test run` and the
  pre-commit hook leave them out. Run them with `pok test e2e`.

### End-to-end tests

`pok test e2e` deploys to real Cloudflare and AWS accounts. It reads these
variables from the environment:

| Variable                                                   | Used by                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`            | The Cloudflare tests                                       |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | The AWS tests, and the Cloudflare `ContainerRegistry` test |
| `ECR_PULL_ACCESS_KEY_ID`, `ECR_PULL_SECRET_ACCESS_KEY`     | The Cloudflare `ContainerRegistry` test                    |

A Cloudflare test is skipped when its variables are missing. An AWS test fails.

The Cloudflare `ContainerImage` test builds an image with Docker, and is
skipped unless the Docker daemon is running.

The accounts need:

- Cloudflare: a token with Edit on Workers Scripts, Workers R2 Storage, Workers
  KV Storage, Containers, Secrets Store and Account API Tokens. The account
  needs a workers.dev subdomain, a Secrets Store and the Workers Paid plan.
- AWS: an IAM user with the policy in `packages/aws/test/policies/e2e-user.json`,
  and a second user that can only pull images, with the policy in
  `packages/aws/test/policies/ecr-pull-user.json`.

Each run names what it creates with `ne2e-` and a random suffix, and deletes it
when it ends. A run that is killed leaves its resources behind. You can delete
anything whose name starts with `ne2e-`, except a `ne2e-lock-*` secret that is
less than 60 minutes old: that is a lock another run holds.
Delete a repository in the Cloudflare registry with
`wrangler containers images delete`.

## Publishing Packages

Create a changeset, when a change should result in a version bump:

```
pok release changeset
```

From the main branch, consolidate changesets, bumping the versions of affected packages:

```
pok release version
```

Then publish to the NPM registry:

```
pok release publish
```
