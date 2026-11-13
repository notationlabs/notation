# Contributing

Every task in this repository runs through `pok`. Run `pok` on its own to list
the commands, or `pok <command> --help` for one of them.

| Command          | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `pok build`      | Build every package                                              |
| `pok dev`        | Watch and rebuild every package                                  |
| `pok test run`   | Run the suite once, as CI and the pre-commit hook do             |
| `pok test watch` | Re-run tests on change                                           |
| `pok test live`  | Build, then run the live tests against a real Cloudflare account |
| `pok typecheck`  | Type-check every package                                         |
| `pok format`     | Format the repository                                            |

## Live tests

Files named `*.live.test.ts` deploy to a real Cloudflare account. `pok test run`
and the pre-commit hook leave them out. Run them with `pok test live`.

The tests read `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, and skip when
either is missing. The token needs the Workers Scripts: Edit permission, and the
account needs a workers.dev subdomain. Set the variables in any way, such as
with 1Password:

```
2password env run cloudflare.env.tpl -- pok test live
```

Each run names what it creates with the prefix `nlive-<6 hex characters>`, and
deletes it when the tests end. A Worker whose name starts with `nlive-` is left
over from a run that was killed, and can be deleted.

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
