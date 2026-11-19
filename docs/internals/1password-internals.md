# 1Password Internals

`@notation/1password` reads 1Password items by running the 1Password CLI, `op`. This page covers how the package runs `op`, how it fetches every item at the start of a plan or deploy, how it computes revisions, and how it keeps values out of errors.

The package uses the engine's `prefetch` operation for credential sources. Read [Secrets Engine](./secrets-engine.md#source-prefetching) first for how plan and deploy call `prefetch`.

| File | Contents |
| :--- | :--- |
| `packages/1password/src/op.ts` | The one function that runs `op` |
| `packages/1password/src/reference.ts` | Parsing and checks of `op://` references |
| `packages/1password/src/items.ts` | Fetching items, decoding, field matching, recording values |
| `packages/1password/src/resources/onepassword-secret.ts` | The schema, `prefetch`, `read`, `loadCredential` and `ItemReplacedError` |

## Running `op`

All calls to `op` go through `opItemGet(item, vault)` in `src/op.ts`. Each call fetches one item:

```sh
op item get <item> --vault=<vault> --format json
```

`<item>` and `<vault>` are the names or IDs from the reference. The vault is always given, because a service account must name a vault for every item.

The function runs `op` in this way:

- **No shell.** It uses `spawn` with an array of arguments, so no argument is ever parsed as shell syntax. It uses `spawn` rather than `execFile` because `execFile` ignores `stdio`, and always gives the child process a pipe on stdin.
- **No values in arguments.** The arguments hold only the item and the vault. Other users of the machine can see them in the process list.
- **stdin is ignored.** `spawn` gets `stdio: ["ignore", "pipe", "pipe"]`.
- **The environment is passed through unchanged.** `op` decides between the desktop app, `OP_SERVICE_ACCOUNT_TOKEN`, and `OP_CONNECT_HOST` with `OP_CONNECT_TOKEN`. The package adds no other way to sign in, and does not fall back from one way to another.
- **`PATH` only on Windows.** Windows looks up a program name without a path in the current folder before `PATH`. The current folder is the user's repository, so an `op.exe` in it must not run. On Windows, `src/op.ts` searches the absolute folders in `PATH` for `op.exe` itself, and runs that file.
- **No check before the real call.** A check such as `op whoami` would be one more call that can show a prompt. When the real call fails with `ENOENT`, the error is "The 1Password CLI, op, is required, and it isn't on PATH. Install it: https://developer.1password.com/docs/cli/get-started/".

The package checks no `op` version. It is tested with `op` 2.32.0.

### Why `op item get`, not `op read`

`op read` returns the value of a field, but not the item's version, and the revision needs the version. Running `op read` and `op item get` for one source would be two calls that can see two states of the item. So the package runs `op item get` alone, and finds the field in the item itself.

The package also never runs `op item list`. `op item get` resolves names, and reports a name that matches two items with the IDs of both.

## Fetching items

`OnePasswordSecret.prefetch` receives every `OnePasswordSecret` whose params are known, and fetches their items in four steps:

1. Make one entry for each item, from the item and the vault in the reference. Two references to the same item share an entry.
2. Run `op item get` for the first entry alone. If the call has not ended after 2 seconds, call `context.notify("Waiting for 1Password. Approve the request in the 1Password app.")`.
3. Once the first call has ended without a failure that concerns every entry, run one call for each other entry, at most eight at a time.
4. Return a map from each entry to its item in `prefetched`, and the sources of failed entries in `failed`.

`read` and `loadCredential` then take the item from `context.prefetched`, and make no `op` call. A source whose `reference` is built from another resource's output is not passed to `prefetch`. Its `read` fetches the item alone, and its `loadCredential` fetches it again.

### Why the first call runs alone

**The first call runs alone because each `op` call that starts before the user approves shows its own prompt.** With the desktop app, an approval lasts for one terminal session, and covers every process that the session starts. This includes the deploy child of `notation watch` (`packages/cli/src/deploy-child.ts`). In a session with no approval, `op` waits up to 60 seconds for the user, and then fails with `authorization timeout`.

These results were measured with `op` 2.32.0 on macOS:

- After `op signout`, a call from a Node grandchild process waited for the prompt, and passed once the user approved. Later calls in the same terminal session did not prompt.
- A call in a new terminal session, with the same parent process and no TTY, prompted again.
- Three calls at the same time showed three prompts.

So the first call gets the approval, and the calls after it need none. With a service account, the first call costs about 1.3 seconds, and an invalid token fails one call instead of eight.

### Why single calls, not batches

`op item get -` reads several items from stdin in one call. These are the measured times for 10 items:

| Method | Time | Prompts in a session with no approval |
| :--- | :--- | :--- |
| One batch of 10 | 6.6 s | 1 |
| Two batches of 5, in parallel | 2.3 s | 2 |
| Ten single calls, in parallel | 1.8 s | 10 |

One single call takes about 1.3 s. The package runs one call alone and then single calls in parallel, so it shows one prompt, and adds about 1.3 s to the time of the parallel calls.

`op` fetches the items of a batch one after another, so a batch is slow. Batches would also need a real pipe on stdin, which Node gives only through `sh` on macOS and Linux, a parser for concatenated JSON documents, and a way to find the failed entry from stderr.

The limit of eight calls at a time is a constant in `src/items.ts`, so that the number of `op` processes stays bounded. It is not part of the API, and can change in a patch release.

### Failed calls

A failed call exits with code 1, and `op` prints a message on stderr. The package reads stderr to decide whether the failure concerns one entry or every entry:

| stderr contains | Failure of | `prefetch` does |
| :--- | :--- | :--- |
| `isn't an item` | One entry | Puts each source of the entry in `failed`, with its reference and `op`'s message, and fetches the other entries |
| `More than one item matches` | One entry | The same |
| Anything else, such as `authorization timeout` or `error initializing client` | Every entry | Starts no more calls, and throws |

A one-entry failure on the first call still lets the other calls run, because `op` had signed in before it printed the message.

For `authorization timeout`, the error adds that a process with no person to approve the prompt, such as an agent or a CI job, needs a service account.

**A message that the package does not know counts as a failure of every entry.** If a later `op` changes one of the two messages, a wrong reference stops `prefetch` with that one error, and the user does not see the other failed sources until the next run. The message that `op` prints for a vault that a service account can't read is not known yet, so it also counts as a failure of every entry.

## The output of `op item get`

These facts were checked with `op` 2.32.0 on macOS:

- The item has `id`, `version`, `updated_at` and `vault.{id,name}`.
- Each field has `id`, `label`, `type`, `purpose`, `reference` and `value`. `CONCEALED` values are in plaintext, without `--reveal`.
- An archived item has `"state": "ARCHIVED"`. An active item has no `state`.
- `op` builds `field.reference` from names where they are unique, and from IDs where they are not, such as for a section with no label.
- A `version` in the input is ignored. A request for version 1 of an item at version 11 returns version 11. So `op` can't fetch a past version.

### Field matching

The package finds the field in the item. Each part of the reference can be a name or an ID, and an ID matches `/^[a-z0-9]{26}$/`. The field matches by its ID or by its label:

- With a section in the reference, only fields in that section match.
- Without a section, exactly one field of the item must match.
- When no field matches, or more than one does, the error lists the `reference` of each field of the item, as `op` prints it. It lists no values.

A file attached to an item does not appear in the output of `op item get`, so a reference to a file fails as a missing field. For a reference that `op read` resolves, the package returns the same value or fails.

### References that the constructor rejects

`src/reference.ts` parses the reference in the constructor of `OnePasswordSecret`, and throws for:

- A syntax error.
- An item name that starts with `-`. The item is an argument of `op`, and `op` would read it as a flag. The error says to use the item's ID.
- Any `?attribute=` or other query. `?attribute=otp` changes every 30 seconds, so there is no fixed value to deploy.

## Revisions

`read` takes the item from `context.prefetched`, or fetches it, and finds the field:

| `track` | Revision |
| :--- | :--- |
| not set | `version:<item id>:<item version>` |
| `"hmac"` or `"scrypt"` | `trackRevision(track, context, value)` (`packages/std/src/track.ts`) |

The item's version is the default, so that a source works with no setup. `track: "hmac"` needs `NOTATION_TRACK_KEY` on every machine.

The default is weaker than it is for `InfisicalSecret`, because 1Password raises the version for any change to the item. A change to another field, the title or the tags gives the source a new revision, and the engine updates every consumer with the same value. With `track`, only a change to the field's value gives a new revision.

### Loading the value

`loadCredential` takes the item from `context.prefetched`, so a deploy loads the same version that its `read` saw. In a resumed deploy, `context.prefetched` holds what `prefetch` fetched at the start of the resume, and the revision in state comes from the first attempt. `loadCredential` checks the item against the revision:

- **Another item ID.** The item was deleted, and another item with the same name was added. `loadCredential` throws `ItemReplacedError`, which asks the user to run deploy again.
- **Another version.** `op` can't fetch the version that `read` saw, so `loadCredential` throws an error that ends "changed after deploy read it. Run deploy again."
- **With `track`.** The hash of the current value must equal the revision, as for `InfisicalSecret`.

## Errors and scrubbing

`op item get` prints every value of the item on stdout, not only the requested field. The package handles stdout and stderr as follows:

- **Decoding.** The package parses stdout as one JSON document, and validates it with valibot. It replaces a parse or validation error with the fixed message "1Password returned output that notation can't read". The message of a `JSON.parse` error contains part of the input, and the input contains values.
- **Recorded values.** The package passes the requested field's value to `recordSecretValue`, whatever the field's type, because a connection URL is often in a text field. It also records every other `CONCEALED` value of the item with eight characters or more. It does not record a shorter one, such as a PIN, because the scrubber replaces every occurrence of a recorded value, and a four-digit value would hide ordinary text in the output.
- **Kept values.** After recording, the package keeps only the values of the fields that a source asked for. These values stay in `prefetched` in memory until the plan or deploy ends.
- **Failed calls.** The package discards the stdout of a failed call. The error message is `op exited with code <code>: <stderr>`, or `op was stopped by <signal>. <stderr>`.
- **stderr.** The package passes stderr through `scrubSecretValues`, and includes it in the error, because messages such as `isn't an item` tell the user what to do. stdout is never included in an error.
- **Checks.** An empty value fails, as for `InfisicalSecret`. An item with `"state": "ARCHIVED"` fails, because `op` still finds an archived item by its ID.

`@notation/1password/resources` exports `OnePasswordError` and `ItemReplacedError`. `OnePasswordError` has `exitCode` (`number | null`, `null` when a signal stopped `op`) and `stderr`, which is scrubbed.

## Not yet tested

- **Service accounts.** Only an invalid `OP_SERVICE_ACCOUNT_TOKEN` has been tested: `op` fails with `error initializing client`, and does not use the desktop app. A test with a real service account and at least 10 items will set the rate limit numbers in the docs, add the message for an unreadable vault to the one-entry messages if it concerns one entry, and lower the limit of eight parallel calls if 1Password throttles them.
- **A denied prompt.** It should fail as a failure of every entry.
- **Windows and Linux.** 1Password's docs say that sub-shells on Windows are approved one by one, and that the prompt on Linux behaves as on macOS.
