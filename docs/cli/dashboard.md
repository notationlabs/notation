# notation dashboard

`notation dashboard` launches a local web UI on `http://localhost:6682` to inspect a stage's recorded state. You can browse deployed resources by group, copy AWS API Gateway URLs, and watch live state updates during deployments.

## Usage

Start the dashboard using the `dashboard` script in starter projects or invoke the CLI binary directly:

::code-group

```sh [Package script]
@pm.run("dashboard")
```

```sh [CLI binary]
./node_modules/.bin/notation dashboard
```

::

When ready, the server prints the local URL:

```text [Terminal]
Notation dashboard is running on:


➜ http://localhost:6682
```

Open `http://localhost:6682` in your browser to inspect the stage's state, and press `Ctrl+C` in the terminal to stop the server.

## Options

`notation dashboard` accepts `--config <path>` and `--stage <stage>`.

Pass `--stage` to inspect a non-default stage, or combine `--config` and `--stage` when running outside the project root:

```sh [Terminal]
notation dashboard --config services/orders/notation.config.ts --stage prod
```

If neither `--stage` nor `defaultStage` is set, the command exits with an error. `dashboard` never compiles or evaluates `entry`, so it works before your first deploy or after moving source files.

By default, the dashboard reads state from `.notation/workflows.db` relative to the config directory.

Set `NOTATION_DATABASE_PATH` to inspect another database file:

```sh [Terminal]
NOTATION_DATABASE_PATH=/var/lib/notation/workflows.db notation dashboard --stage prod
```

## Live updates

Because `notation dashboard` reads the same local SQLite database written by [`notation deploy`](./deploy.md), [`notation destroy`](./destroy.md), and [`notation watch`](./watch.md), you can run it alongside an active deployment session:

::code-group

```sh [Terminal 1 (dashboard)]
@pm.run("dashboard")
```

```sh [Terminal 2 (watch)]
@pm.run("watch")
```

::

The dashboard opens state read-only, so it never acquires a hold or blocks concurrent deployments, and updates automatically as state changes.

## Resource tree

The left sidebar organizes every recorded resource in the stage by its `group` ancestry:

| Element | Behavior |
| :--- | :--- |
| Nested groups | Renders [resource groups](../core/resources.md) as `<group.type> <group.id>` headings |
| Group sorting | Orders groups alphabetically at each nesting level by `type` and `id` |
| Ungrouped section | Lists standalone resources under an `Ungrouped` heading |
| Retired badges | Displays `<count> retired` on resources with superseded instances |

On initial load, the UI selects the first API Gateway resource or falls back to the first resource in state. Click any item in the sidebar to view its details.

## Resource details

The right pane shows the selected resource's `id`, `type`, and any retired instances. AWS API Gateway resources also render **Open in AWS console→** and a clickable endpoint URL link. Cloudflare `WorkerScript` resources also show the Worker's script name.

## Retired instances

When a replacement leaves superseded instances awaiting cleanup, the detail pane lists each retired instance's timestamp and output JSON until `deploy` deletes it.
