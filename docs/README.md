# Documentation

This directory is both the documentation source and the site that publishes it.
The site is built by [`@notation/docs`](https://github.com/djgrant/docs), a Vite
preset that supplies the whole docs shell; everything project-specific lives here.

## Commands

Run these from this directory:

| Command | What it does |
| --- | --- |
| `pnpm exec docs dev --port 3005` | Dev server on http://localhost:3005 |
| `pnpm exec docs build` | Production build into `docs/dist` |
| `pnpm exec docs deploy` | Build, then deploy the `notation-docs` Cloudflare Worker |

## Layout

| Path | Purpose |
| --- | --- |
| `manual/`, `cli/`, `resources/`, `internals/` | Markdown, one directory per docs category |
| `*/nav.ts` | Sidebar for that category, beside its Markdown |
| `index.ts` | Orders the categories; must match `categories` in `vite.config.ts` |
| `pages/` | Extra routes outside `/docs`, such as the landing page |
| `views/` | React components used by those pages |
| `vite.config.ts` | Title, nav categories, favicon, logo, version source, deployment |

The build fails on a broken link, a duplicate slug or an undeclared category, so
a nav entry and its `.md` file always stay in step.

## Updating the framework

`@notation/docs` is unpublished and lives in a private repo, so it is installed
as a git dependency pinned to a subdirectory. The lockfile records the commit it
resolved, so picking up framework changes is explicit:

```sh
pnpm --filter @notation/docs-site update @notation/docs
```

CI cannot clone a private repo without a deploy key, so the workflows still
install with `--filter '!@notation/docs-site'`. Deploys run locally.

To iterate on the framework and this site together, point the dependency at your
local checkout (`file:../../../docs/packages/docs`) and revert before committing.
