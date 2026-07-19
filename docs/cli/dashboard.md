# notation dashboard

```sh
notation dashboard
```

Starts a local web dashboard for observing deployment state.

```sh
notation dashboard
```

The dashboard uses the same state backend as deploy and destroy. Set
`NOTATION_STATE_PATH` to select SQLite:

```sh
NOTATION_STATE_PATH=.notation/state.db notation dashboard
```

The server reads through `StateBackend`, so file and SQLite state produce the same
dashboard payload.
