# Contributing

Every task in this repository runs through `pok`. Run `pok` on its own to list
the commands, or `pok <command> --help` for one of them.

| Command | What it does |
| --- | --- |
| `pok build` | Build every package |
| `pok dev` | Watch and rebuild every package |
| `pok test run` | Run the suite once, as CI and the pre-commit hook do |
| `pok test watch` | Re-run tests on change |
| `pok typecheck` | Type-check every package |
| `pok format` | Format the repository |
| `pok docs dev` | Documentation site on http://localhost:3005 |
| `pok docs build` | Build the documentation site |
| `pok docs deploy` | Deploy the documentation site to Cloudflare |

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
