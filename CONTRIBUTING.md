# Contributing

Every task in this repository runs through `pok`. Run `pok` on its own to list
the commands, or `pok <command> --help` for one of them.

| Command          | What it does                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `pok build`      | Build every package                                                    |
| `pok dev`        | Watch and rebuild every package                                        |
| `pok test run`   | Run the suite once, as CI and the pre-commit hook do                   |
| `pok test watch` | Re-run tests on change                                                 |
| `pok test e2e`   | Build, then run the end-to-end tests against a real Cloudflare account |
| `pok typecheck`  | Type-check every package                                               |
| `pok format`     | Format the repository                                                  |

## Tests

The tests of a provider mirror its source. Each resource or construct has two
files side by side, such as `test/resources/workers/worker-script.test.ts` and
`test/resources/workers/worker-script.e2e.test.ts`:

- `<name>.test.ts` holds the unit tests. They mock the provider's API, and
  `pok test run` runs them.
- `<name>.e2e.test.ts` holds the end-to-end tests. They write a project to a
  temp directory, run the built CLI's `deploy` and `destroy` in it, and check
  the result in a real Cloudflare account. `pok test run` and the pre-commit
  hook leave them out. Run them with `pok test e2e`.

The end-to-end tests share their setup, in `packages/cloudflare/test/e2e.ts`.
They read `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the
environment, and are skipped when either is missing. The token needs the
Workers Scripts: Edit permission, and the account needs a workers.dev
subdomain.

Each test file names what it creates with the prefix `ne2e-<6 hex characters>`,
and deletes it when its tests end. A Worker whose name starts with `ne2e-` is
left over from a run that was killed, and can be deleted.

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
