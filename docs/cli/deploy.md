# notation deploy

```sh
notation deploy [--config <path>] [--stage <stage>] [--replace <id>@<hash>] [--override-loss-protection <id>] [--credential <id>.<credential>@<hash>=<variable>]
```

| Option                                             | Meaning                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <path>`                                  | The config file. Default: the nearest `notation.config.ts`.                                                                                                         |
| `--stage <stage>`                                  | The stage. Default: `defaultStage`.                                                                                                                                 |
| `--replace <id>@<hash>`                            | Replace the resource with this ID. Repeatable. See [Replacing a resource](#replacing-a-resource).                                                                   |
| `--override-loss-protection <id>`                  | Replace a resource that `--replace` names, though its class refuses the replace. Repeatable.                                                                        |
| `--credential <id>.<credential>@<hash>=<variable>` | Give deploy the value of a credential from the environment variable. Repeatable. See [A credential that you rotate by hand](#a-credential-that-you-rotate-by-hand). |

Compiles the entry file and deploys it to the stage. Each stage has its own state, under the key `<app>:<stage>`. See [Project Config](../manual/project-config.md).

```sh
notation deploy --stage prod
```

## Replacing a resource

Deploy replaces a resource by itself only when a param that forces replacement changes. A resource can also be broken at the provider in a way that a read does not show. Its params have not changed, so every deploy plans a noop for it. `--replace` asks deploy to replace it:

```sh
notation deploy --stage prod --replace lambda:orders:role@3c1f9a02
```

The part before the last `@` is the resource ID as state records it. For a resource that a construct declared, that is the ID that the construct made, such as `worker:api:subdomain` for the workers.dev subdomain of `$worker({ id: "api" })`. When the part after the last `@` is not 8 hex characters, the whole value is the ID, with no hash.

The part after the `@` is the instance hash: the first 8 hex characters of a SHA-256 of the state key `<app>:<stage>` and the resource's primary key. Uppercase hex characters are read as lowercase. Deploy fails, before it changes anything, when the hash does not match:

```text
✗ lambda:orders:role has the instance hash 9e04b7d1 in this stage, not 3c1f9a02.
```

The hash is important because it ties the command to one resource in one stage. A command copied from the plan of another stage fails, because the state key differs. A command run again after the resource was replaced fails too when the key is generated or assigned by the provider, because the key differs. Deploy fails when `--replace` has no hash. To get the command with the hash, run [`notation plan --stage <stage> --replace <id>`](./plan.md#replacing-a-resource) for the same stage.

Deploy replaces the resource as it would for a changed param:

- A resource with a generated name is replaced create-first: deploy creates the replacement under a new name, and deletes the old resource at the end of the deploy. Every other resource is replaced delete-first.
- Deploy decides each dependent again with the outputs of the replacement. A dependent that takes a new output is updated, and a dependent whose changed param forces replacement is replaced. You do not name the dependents.
- A deploy without the flag replaces nothing. Notation does not record the request in state.

Deploy fails, before it changes anything, when:

| Case                                                                     | Error                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ID is not in state, but is in code                                   | `lambda:orders:role is not in state, so there is nothing to replace. Deploy will create it.`                                                                                                                    |
| The ID is not in state or in code                                        | `lambda:orders:role is not in state or in code, so there is nothing to replace.`                                                                                                                                |
| The ID is in state, but not in code                                      | `lambda:orders:role is no longer in code. Deploy will delete it.`                                                                                                                                               |
| An earlier deploy did not finish the create of the resource              | `lambda:orders:role has a create that an earlier deploy did not finish. Run deploy without --replace to recover it first.`                                                                                      |
| The resource is a source                                                 | `stripe-key is a source, and a source is never replaced. Nothing exists at a provider to replace.`                                                                                                              |
| `--replace` has no hash                                                  | `--replace lambda:orders:role needs the instance hash, as --replace lambda:orders:role@<instance hash>. Run notation plan --stage prod --replace lambda:orders:role to print the deploy command with the hash.` |
| The part after the last `@` is hex of the wrong length, after a known ID | `The instance hash 3c1f9a0 of lambda:orders:role is malformed. An instance hash is 8 hex characters.`                                                                                                           |
| The hash does not match                                                  | `lambda:orders:role has the instance hash 9e04b7d1 in this stage, not 3c1f9a02.`                                                                                                                                |
| `--override-loss-protection` names a resource that `--replace` does not  | `--override-loss-protection bucket:uploads needs --replace bucket:uploads.`                                                                                                                                     |

### Loss protection

Some classes refuse a replace that `--replace` asks for, because the replace deletes data. The R2 bucket and the KV namespace are two of them:

```text
✗ kv:cache: Replacing this KV namespace would delete it and its keys. To replace it, pass --override-loss-protection kv:cache with --replace.
```

`--override-loss-protection <id>` turns off this check for one resource that `--replace` also names:

```sh
notation deploy --replace kv:cache@5d0a7c13 --override-loss-protection kv:cache
```

The flag turns off only the check of the named resource's class. A param whose change would replace the resource still fails with its own message, and a dependent whose replace is refused still fails the deploy.

With the flag, the replace of a KV namespace deletes its keys. The replace of an R2 bucket deletes the bucket first, and Cloudflare deletes only an empty bucket. So the deploy fails at the delete while the bucket has objects, and the bucket and its objects stay. Delete the objects first to replace the bucket.

### Resuming

Notation saves the `--replace`, `--override-loss-protection` and `--credential` flags with the execution. A resume with `--execution-id` reads them from there, so you can leave them out. If you pass them, they must be the flags that the execution started with:

```text
✗ Execution 1f3e… was started with --replace lambda:orders:role@3c1f9a02. Leave out --replace and --credential, or pass the same flags.
```

A resume does not check the hash again, because a create-first replace has already changed the key.

## A credential that you rotate by hand

A [credential](../manual/secrets.md#credentials) is a secret output of a resource, such as the value of an API token. Deploy holds a credential's value in memory only, and Notation does not store it. So a later deploy holds no value. When a resource that takes the value is created or updated, deploy gets a value again:

| The credential                                      | Deploy                                                      |
| --------------------------------------------------- | ----------------------------------------------------------- |
| of a source, such as `sources.Env`                  | loads the value from the source                             |
| of a resource with `rotate`, such as `AccountToken` | rotates it, and updates every resource that takes the value |
| of a resource without `rotate`                      | fails, and asks you for a new value                         |

Some providers have no API that issues another value. A GitHub App's private key is one: you generate a new key in the app's settings. In this case, plan fails. Deploy checks for it before it changes anything, and again before it writes the resource that needs the value. Both print two commands, with the `--config`, `--stage` and other flags of the command that you ran:

```text
✗ `app-key-secret` is new, and takes `app.privateKey`. Notation does not store the value, and `github/App` has no operation that issues another.

  Generate a new private key in the GitHub App's settings, under Private keys. Then set the environment variable `APP_PRIVATE_KEY` to the value, and pass it:
    notation deploy --stage prod --credential app.privateKey@5d2e8b17=APP_PRIVATE_KEY

  Or replace `app`. Deploy deletes `app` and creates it again with a new value, so whatever exists only in the old `app` is lost:
    notation deploy --stage prod --replace app@5d2e8b17
```

The first sentence gives the reason that the resource needs the value now. The message puts each name in backticks:

| First sentence                                                                                      | Reason                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `` `app-key-secret` is new, and takes `app.privateKey`.``                                           | The resource was added after the deploy that created the app.                                                    |
| ``An earlier deploy did not finish the create of `app-key-secret`, which takes `app.privateKey`.``  | An earlier deploy failed while it created the resource.                                                          |
| ``Deploy replaces `app-key-secret`, which takes `app.privateKey`.``                                 | The replacement is created with the value.                                                                       |
| `` `app-key-secret` takes `app.privateKey`, and has not received its current value.``               | An earlier deploy failed before it updated the resource, or the resource now takes the value under another name. |
| `` `app-key-secret` takes `app.privateKey`, and state has no record of a value for it.``            | The create of the app returned no value for the credential, or one that its validator rejects.                   |
| `` `app-key-secret` takes `app.privateKey`, and the deploy run that received its value has ended.`` | The deploy stopped after it created the app, and was resumed.                                                    |

- **`--credential`** gives deploy a value that you issue at the provider. The app keeps its ID. The sentence above the command comes from the resource's class. A class that gives none prints ``Issue a new value of `privateKey` at the provider of `github/App`.``
- **`--replace`** replaces the resource, as in [Replacing a resource](#replacing-a-resource). The new app has a new ID and a new key, and whatever exists only in the old app is lost.

When several credentials need a new value, plan lists all of them in one error. Each credential has the same lines as above, with the two flags in place of the two commands. The deploy command comes once, at the end:

```text
✗ 2 credentials need a new value before deploy can run. Each is listed below with two flags. Choose one flag for each.

`app-key-secret` is new, and takes `app.privateKey`. Notation does not store the value, and `github/App` has no operation that issues another.

  Generate a new private key in the GitHub App's settings, under Private keys. Then set the environment variable `APP_PRIVATE_KEY` to the value, and pass it:
    --credential app.privateKey@5d2e8b17=APP_PRIVATE_KEY

  Or replace `app`. Deploy deletes `app` and creates it again with a new value, so whatever exists only in the old `app` is lost:
    --replace app@5d2e8b17

`db-url` is new, and takes `db.password`. Notation does not store the value, and `neon/Role` has no operation that issues another.

  Issue a new value of `password` at the provider of `neon/Role`. Then set the environment variable `DB_PASSWORD` to the value, and pass it:
    --credential db.password@91af03c2=DB_PASSWORD

  Or replace `db`. Deploy deletes `db` and creates it again with a new value, so whatever exists only in the old `db` is lost:
    --replace db@91af03c2

Then run deploy with the flags that you chose:
  notation deploy --stage prod <flags>
```

A `--replace` can create other resources again, so the next plan can find a credential that this one did not list.

`--credential` reads the value from the environment variable that it names, so the value is never an argument on the command line:

```sh
APP_PRIVATE_KEY="$(cat app.pem)" notation deploy --stage prod --credential app.privateKey@5d2e8b17=APP_PRIVATE_KEY
```

The flag has four parts:

| Part              | Example           | Meaning                                                                                                        |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `<id>`            | `app`             | The resource ID as state records it. The part before `@` is split at its last dot, so an ID can hold a dot.    |
| `<credential>`    | `privateKey`      | The name of the credential.                                                                                    |
| `<instance hash>` | `5d2e8b17`        | The instance hash of the resource, as `--replace` takes it. See [Replacing a resource](#replacing-a-resource). |
| `<variable>`      | `APP_PRIVATE_KEY` | The environment variable that holds the value.                                                                 |

**The hash ties the command to one resource in one stage.** The same resource has another hash in every other stage. So a command copied from the plan of another stage fails:

```text
✗ app has the instance hash 9e04b7d1 in this stage, not 5d2e8b17.
```

Plan prints the hash, so you do not type it. Deploy fails when `--credential` has no hash. To get the command with the hash, run [`notation plan --credential <id>.<credential>=<variable>`](./plan.md#passing-a-credential).

Deploy cannot tell whether the passed value is the one that the other resources hold. It gives the credential a new version, and updates every resource that takes it.

Deploy fails, before it changes anything, when:

| Case                                         | Error                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ID is not in code                        | `--credential app.privateKey: app is not in code.`                                                                                                                                    |
| The resource is a source                     | `--credential stripe-key.value: stripe-key is a source. Deploy loads a source's value from the source.`                                                                               |
| The name is not a credential of the resource | `--credential app.key: key is not a credential of app.`                                                                                                                               |
| The credential has `rotate`                  | `--credential deploy-token.Value: cloudflare/tokens/AccountToken can rotate Value, so deploy gets a new value itself. --credential is accepted only for a credential without rotate.` |
| `--replace` names the same resource          | `--credential app.privateKey cannot be given with --replace app: the replacement is created with a new value.`                                                                        |
| The resource is not in state                 | `--credential app.privateKey: app is not in state, so it has no value to set. Deploy creates it, and the create returns the value.`                                                   |
| The hash is not 8 hex characters             | `The instance hash 5d2e8b1 of app is malformed. An instance hash is 8 hex characters.`                                                                                                |
| The hash does not match                      | `app has the instance hash 9e04b7d1 in this stage, not 5d2e8b17.`                                                                                                                     |
| The variable is not set                      | `--credential app.privateKey reads APP_PRIVATE_KEY, which is not set.`                                                                                                                |
| The flag names the same credential twice     | `--credential app.privateKey is given more than once.`                                                                                                                                |

A resume reads the value from the variable again, so the variable must be set for the resume too.

Deploy removes every credential's value from the errors that it records and prints. See [Secrets](../manual/secrets.md).

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

6. **Delete orphans** – persisted resources absent from the graph are deleted when their resource type is registered. A type is registered when a resource in the graph has it, or when the provider package named in its state record is installed and exports its class. The record of a source needs no class, and is always deleted.

State, step results, timers, queued tasks, and resource stores are persisted to `.notation/workflows.db`. Set `NOTATION_DATABASE_PATH` to choose another SQLite database path.
