# notation deploy

```sh
notation deploy <entryPoint>
```

Compiles and deploys the stack to AWS.

```sh
notation deploy infra/api.ts
```

## Event stream

`--json` writes versioned reconciler events to stdout as newline-delimited JSON. Build
output and diagnostics move to stderr.

```sh
notation deploy infra/api.ts --json > deploy.ndjson
```

## What happens

1. **Compile** – esbuild compiles infra and runtime modules to `dist/`.

2. **Build resource graph** – imports the compiled output and collects the declared resources.

3. **Reconcile** – the reconciler compares desired state (graph) against current state (`.notation/state.json`):
   - New resources → **create**
   - Changed params → **update**
   - No changes → **noop**
   - Orphaned resources (in state but not in graph) → **delete**

4. **Topological deployment** – resources deploy in dependency order (levels). Resources at the same level deploy concurrently.

5. **Drift detection** – enabled by default. Reads actual AWS state and compares against stored state. If drifted, Notation updates to match your definition.

State is persisted to `.notation/state.json` after each operation. Set
`NOTATION_STATE_PATH` to a path ending in `.db` or `.sqlite` to use SQLite:

```sh
NOTATION_STATE_PATH=.notation/state.db notation deploy infra/api.ts
```
