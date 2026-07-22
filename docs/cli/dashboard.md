# notation dashboard

```sh
notation dashboard <entryPoint>
```

Starts a local web dashboard for observing the deployment's YieldStar resource stores.

```sh
notation dashboard infra/api.ts
```

The dashboard reads `.notation/workflows.db`, the same database used by deploy, destroy, and plan. Set `NOTATION_STATE_PATH` to choose another SQLite database path.
