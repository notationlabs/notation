# notation deploy

```sh
notation deploy [--config <path>] [--stage <stage>] [--replace <id>@<hash>] [--override-loss-protection <id>]
```

| Option                            | Meaning                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--config <path>`                 | The config file. Default: the nearest `notation.config.ts`.                                       |
| `--stage <stage>`                 | The stage. Default: `defaultStage`.                                                               |
| `--replace <id>@<hash>`           | Replace the resource with this ID. Repeatable. See [Replacing a resource](#replacing-a-resource). |
| `--override-loss-protection <id>` | Replace a resource that `--replace` names, though its class refuses the replace. Repeatable.      |

Compiles the entry file and deploys it to the stage. Each stage has its own state, under the key `<app>:<stage>`. See [Project Config](../manual/project-config.md).

```sh
notation deploy --stage prod
```

## Replacing a resource

Deploy replaces a resource by itself only when a param that forces replacement changes. A resource can also be broken at the provider in a way that a read does not show. Its params have not changed, so every deploy plans a noop for it. `--replace` asks deploy to replace it:

```sh
notation deploy --stage prod --replace lambda:orders:role@3c1f9a02
```

The part before the last `@` is the resource ID as state records it. For a resource that a construct declared, that is the ID that the construct made, such as `worker:api:subdomain` for the workers.dev subdomain of `$worker({ id: "api" })`.

The part after the `@` is the instance hash: the first 8 hex characters of a SHA-256 of the state key `<app>:<stage>` and the resource's primary key. Deploy fails, before it changes anything, when the hash does not match:

```text
✗ lambda:orders:role has the instance hash 9e04b7d1 in this stage, not 3c1f9a02.
```

The hash is important because it ties the command to one resource in one stage. A command copied from the plan of another stage fails, because the state key differs. A command run again after the resource was replaced fails too when the key is generated or assigned by the provider, because the key differs. Deploy fails when `--replace` has no hash. To get the command with the hash, run [`notation plan --replace <id>`](./plan.md#replacing-a-resource).

Deploy replaces the resource as it would for a changed param:

- A resource with a generated name is replaced create-first: deploy creates the replacement under a new name, and deletes the old resource at the end of the deploy. Every other resource is replaced delete-first.
- Deploy decides each dependent again with the outputs of the replacement. A dependent that takes a new output is updated, and a dependent whose changed param forces replacement is replaced. You do not name the dependents.
- A deploy without the flag replaces nothing. Notation does not record the request in state.

Deploy fails, before it changes anything, when:

| Case                                                                    | Error                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The ID is not in state                                                  | `lambda:orders:role is not in state, so there is nothing to replace. Deploy will create it.`                               |
| The ID is in state, but not in code                                     | `lambda:orders:role is no longer in code. Deploy will delete it.`                                                          |
| An earlier deploy did not finish the create of the resource             | `lambda:orders:role has a create that an earlier deploy did not finish. Run deploy without --replace to recover it first.` |
| `--override-loss-protection` names a resource that `--replace` does not | `--override-loss-protection bucket:uploads needs --replace bucket:uploads.`                                                |

### Loss protection

Some classes refuse a replace, because the replace deletes data. The R2 bucket and the KV namespace are two of them:

```text
✗ bucket:uploads: Replacing this R2 bucket would delete it and its objects. To replace it, pass --override-loss-protection bucket:uploads with --replace.
```

`--override-loss-protection <id>` turns off this check for one resource that `--replace` also names:

```sh
notation deploy --replace bucket:uploads@5d0a7c13 --override-loss-protection bucket:uploads
```

The flag turns off only the check of the named resource's class. A param whose change would replace the resource still fails with its own message, and a dependent whose replace is refused still fails the deploy.

### Resuming

Notation saves the `--replace` and `--override-loss-protection` flags with the execution. A resume with `--execution-id` reads them from there, so you can leave them out. If you pass them, they must be the flags that the execution started with:

```text
✗ Execution 1f3e… was started with --replace lambda:orders:role@3c1f9a02. Leave out --replace, or pass the same flags.
```

A resume does not check the hash again, because a create-first replace has already changed the key.

## Secrets

Deploy writes each secret from its source. For a secret without a source that doesn't exist yet, deploy asks for the value with a hidden prompt on a terminal. With no terminal, or with `--json`, it fails with the [`notation secret set`](./secret.md) command to run first. See [Secrets](../manual/secrets.md).

Deploy removes every secret value that it read from the errors that it records and prints.

## Event stream

`--json` writes versioned reconciler events to stdout as newline-delimited JSON. Build output, the execution ID, and diagnostics move to stderr.

```sh
notation deploy --stage prod --json > deploy.ndjson
```

## Durable execution

The command prints its execution ID before it starts provider work, and the command that resumes the execution:

```sh
Execution ID 0195f0c2-7d1e-7b4a-9c3e-2f6a8b1d4e70
To resume after a crash, run notation deploy --execution-id 0195f0c2-7d1e-7b4a-9c3e-2f6a8b1d4e70
```

When a deploy starts, Notation saves the state key `<app>:<stage>` with the execution. When you resume, the command reads the stage from the saved key, so you don't pass `--stage`. The command still needs the config, because the config names the entry file. If you deployed with `--config`, the printed command includes it.

The command fails if the config's `app` is not the saved app, or if you pass a `--stage` that is not the saved stage:

```sh
Execution <id> is for stage prod, not dev. Leave out --stage, or pass --stage prod
```

Do not reuse a completed execution ID for a new deploy or for destroy.

Retryable provider conditions and consistency reads suspend on durable SQLite timers. The CLI stays resident until the scheduler wakes the execution and the workflow completes. Provider results are replayed after their heap checkpoint, but a crash after the provider accepts a create or update and before that checkpoint repeats the call, so provider mutations must be idempotent. Reconciler event consumers must tolerate the equivalent duplicate-delivery window.

## What happens

1. **Compile** – Rolldown compiles infrastructure and runtime modules to `dist/`. See [notation compile](./compile.md).

2. **Build resource graph** – the CLI imports the compiled output in-process and collects declared resources.

3. **Order dependencies** – dependency levels run in topological order.

4. **Reconcile** – Notation compares desired resources with `@notation/durable` stores, then creates, updates, recreates, or leaves each resource unchanged.

5. **Detect drift** – unchanged resources are read from the provider and repaired when their remote state differs.

6. **Delete orphans** – persisted resources absent from the graph are deleted when their resource type is registered. A type is registered when a resource in the graph has it, or when the provider package named in its state record is installed and exports its class.

State, step results, timers, queued tasks, and resource stores are persisted to `.notation/workflows.db`. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
