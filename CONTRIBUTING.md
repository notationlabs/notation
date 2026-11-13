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

Each provider's end-to-end tests share one setup, in `test/e2e.ts` in the
provider's package. They read the provider's credentials from the environment,
and are skipped when any is missing. Each test file names what it creates with
a prefix for the run, and deletes it when its tests end.

### Cloudflare

- Credentials: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token
  needs the Workers Scripts: Edit permission, and the account needs a
  workers.dev subdomain.
- Prefix: `ne2e-<6 hex characters>`. A Worker whose name starts with `ne2e-` is
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
