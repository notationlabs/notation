# CLI Flags

`@notation/cli` provides the `notation` binary for building, planning, deploying, destroying, and inspecting Notation applications on Node.js `>=22.13`.

## Commands

Every command except `compile` resolves an `<app>:<stage>` deployment from `notation.config.ts`:

| Command | Description |
| :--- | :--- |
| `notation compile` | Bundles infrastructure and runtime modules into `dist/` |
| `notation dashboard` | Starts the local state viewer on port `6682` |
| `notation deploy` | Compiles, acquires the deployment hold, and converges resources |
| `notation destroy` | Compiles and deletes persisted resources in reverse dependency order |
| `notation plan` | Compiles and previews pending changes with drift detection |
| `notation viz` | Evaluates the resource graph and prints a Mermaid Live Editor URL |
| `notation watch` | Watches project files and redeploys via child `deploy` runs |

## Shared flags

Shared flags behave identically across every command that accepts them:

| Flag | Description |
| :--- | :--- |
| `--config <path>` | Loads an explicit `notation.config.ts` path |
| `--stage <name>` | Sets the target deployment stage |
| `--json` | Forces machine-readable JSON output on `stdout` |
| `--pretty` | Forces human-readable terminal formatting |

`--config` works on all seven commands. Without it, Notation searches upward from `process.cwd()` for `notation.config.ts`, stopping at the first directory containing `package.json`, and resolves `entry`, `dist/`, and `.notation/workflows.db` relative to the config directory.

`--stage` works on `dashboard`, `deploy`, `destroy`, `plan`, `viz`, and `watch`. It defaults to `defaultStage` in `notation.config.ts`, failing if neither is set, and requires `1` to `32` characters from `a-z`, `0-9`, and `-` with no leading, trailing, or double `-`.

`--json` and `--pretty` work on `deploy`, `plan`, and `destroy` and conflict with each other. `--json` routes diagnostics to `stderr`.

## Per-command flags

Command-specific flags control execution resumption, compilation, drift checks, replacements, and credential injection:

| Flag | Description |
| :--- | :--- |
| `--execution-id <id>` | Resumes or names an execution instead of generating a UUID |
| `--no-compile` | Skips compilation and deploys existing `dist/` output |
| `--no-drift-detection` | Skips live `read` drift checks on unchanged resources |
| `--replace <target>` | Forces replacement of a recorded resource matching state |
| `--override-loss-protection <id>` | Bypasses class-level `rejectChange` guards for a replaced resource |
| `--credential <target>` | Supplies a non-rotatable credential from an environment variable |

`--execution-id` works on `deploy` and `destroy`. `--no-compile` and `--no-drift-detection` work only on `deploy`; `--no-drift-detection` still runs new resources, parameter updates, and credential sources.

`--replace` is repeatable on `deploy` (`<id>@<hash>`) and `plan` (`<id>[@<hash>]`). It fails if `<id>` is missing from code or state, has an unfinished `"creating"` record, or is a credential source.

`--override-loss-protection` is repeatable on `deploy` and `plan`. Each `<id>` requires a matching `--replace` naming the same `<id>`, and the flag does not bypass parameter-level `rejectReplace` guards.

`--credential` is repeatable on `deploy` (`<id>.<credential>@<hash>=<variable>`) and `plan` (`<id>.<credential>[@<hash>]=<variable>`), reading `process.env[variable]`. It rejects duplicate `<id>.<credential>` targets, missing resources, credential sources, credentials with `rotate`, uncreated or `"creating"` records, and resources named by `--replace`.

## Execution ID admission

`deploy` and `destroy` enforce strict deployment and workflow binding whenever `--execution-id <id>` is passed:

| Check | Behavior |
| :--- | :--- |
| Unrecognized ID | Starts a new execution with `<id>` and prints a resume command |
| Config matching | Loads saved `{ app, stage }` and rejects app or `--stage` mismatches |
| Workflow binding | Rejects resuming across different workflows or deployment IDs |
| Failed executions | Rejects resuming executions whose `outcome.status` is `"failed"` |
| Override consistency | Reuses saved overrides when omitted and rejects mismatched override flags |

For a new execution, `--stage` falls back to `defaultStage` and the printed resume command omits `--stage`. On resume, workflows must match (`"deploy"` vs `"destroy"`), deployment IDs must match `<app>:<stage>`, and `app` must match `notation.config.ts`. To recover after a failed execution, run `deploy` or `destroy` without `--execution-id` to start fresh against converged state. On `deploy` resume, `--replace`, `--override-loss-protection`, and `--credential` are reused when omitted.

## Target string syntax

Override flags parse resource identifiers, instance hashes, and environment variable names using deterministic delimiters.

### Instance hashes

An instance hash is the first 8 lowercase hexadecimal characters of `SHA-256(JSON.stringify([deploymentId, sortedPrimaryKeys]))` (`[0-9a-f]{8}`). Uppercase hex inputs are normalized to lowercase. `notation plan` validates `@<hash>` when supplied and prints ready-to-run `notation deploy` commands containing resolved hashes; `notation deploy` requires `@<hash>` on new runs.

### Replace targets

`--replace` parses `<id>@<hash>` at the last `@`:

```text [Target format]
--replace <id>          (valid on plan)
--replace <id>@<hash>   (required on deploy)
```

If there is no `@` after index `0` or the suffix is not 8 hex characters, the entire value is parsed as `<id>` without a hash. Hex suffixes of any other length for a known resource ID fail validation.

### Loss-protection targets

`--override-loss-protection` accepts the bare resource `<id>` with no `@<hash>` suffix:

```text [Target format]
--override-loss-protection <id>
```

Each named `<id>` must also appear in a `--replace` flag on the same invocation.

### Credential targets

`--credential` parses `<id>.<credential>[@<hash>]=<variable>` from right to left:

```text [Target format]
--credential <id>.<credential>=<ENV_VAR>          (valid on plan)
--credential <id>.<credential>@<hash>=<ENV_VAR>   (required on deploy)
```

Splitting at the last `=` yields `<variable>`, splitting at the last `@` after the last `.` extracts `<hash>`, and splitting at the last `.` separates `<id>` (which may contain dots) from `<credential>`. In `deploy`, `process.env[variable]` must be set and non-empty.

## Output mode selection

When neither `--json` nor `--pretty` is passed, `deploy`, `plan`, and `destroy` select an output mode from `process.stdout.isTTY` and `process.env.CI`:

| Condition | Selected mode |
| :--- | :--- |
| Flag `--json` | `json` |
| Flag `--pretty` | `pretty` |
| TTY or active `CI` | `pretty` |
| Non-TTY without `CI` | `json` |

`CI` is active for any value other than `""`, `"false"`, or `"0"`. When non-TTY non-CI output falls back to `json`, Notation writes `"stdout is not a terminal, so the output is JSON. Pass --pretty for readable output.\n"` to `stderr`. In `pretty` mode, ANSI colors render via Node's `util.styleText` and disable automatically when the target stream (`stdout` for `info`, `stderr` for `warn` and `error`) is not a TTY or `NO_COLOR` is set.

## Stream routing

Notation isolates machine-readable output from diagnostics across `stdout` and `stderr`:

| Mode | Routing |
| :--- | :--- |
| Pretty mode | Banners, compiler logs, summaries, and `info` go to `stdout`; warnings and errors go to `stderr` |
| JSON deploy and destroy | `"version": 1` NDJSON events go to `stdout`; all other writes redirect to `stderr` |
| JSON plan | Single formatted `Plan` JSON goes to `stdout`; compiler logs and progress route to `stderr` |

## Exit codes

Commands exit with `0` or `1`:

| Code | Meaning |
| :--- | :--- |
| `0` | Command completed without error |
| `1` | Invalid flags, build or validation failure, conflict, or provider error |

`notation plan` exits `0` even when changes are pending. Exit code `1` covers invalid flags, compilation or validation failures, `ResourceCycleError`, `UnobtainableCredentialError`, hold or admission conflicts, and provider errors. `notation watch` also exits `1` after any active deploy finishes if `notation.config.ts` changes. Missing AWS credentials (`CredentialsProviderError`) print `~/.aws/credentials` and `AWS_PROFILE` instructions to `stderr` before exiting `1`, and recorded secret values are scrubbed with `<hidden>` across error output.

## Pretty symbols

Pretty output formats plan summary lines and live reconciler events with distinct single-character prefixes.

### Plan summary symbols

`notation plan` prints each changed node using these prefixes:

| Symbol | Meaning |
| :--- | :--- |
| `+` | `create` |
| `~` | `update`, `drift-update`, `rotate`, or `pass` |
| `+/-` | `replace` or `drift-replace` with `replaceOrder: "create-first"` |
| `-/+` | `replace` or `drift-replace` with `replaceOrder: "delete-first"` |
| `±` | `drift-recreate` |
| `-` | `delete-orphan` or `delete-retired` |

`noop` nodes that rotate or pass credentials use `~`; unchanged `noop` nodes without `rotates` are omitted from the item list and counted as `unchanged` in the final summary line.

### Event stream symbols

Live reconciler subscribers format each `ReconcilerEvent` line by event type and status:

| Symbol | Event |
| :--- | :--- |
| `→` | `reconciler.deploy.decision` on `stdout` |
| `~` | `reconciler.drift.detected` with indented JSON diff on `stdout` |
| `…` | `reconciler.operation.lifecycle` start on `stdout` |
| `✓` | `reconciler.operation.lifecycle` success on `stdout` |
| `-` | `reconciler.operation.lifecycle` skip on `stdout` |
| `○` | `reconciler.operation.lifecycle` dry-run on `stdout` |
| `✗` | `reconciler.operation.lifecycle` error on `stderr` |
| `!` | Warning event on `stderr` |

`noop` decisions are omitted from `reconciler.deploy.decision`. Error lines (`✗`) are followed by error details on `stderr`. Warning events (`!`) cover `hold.waiting`, `orphan-deletion.skipped`, `provider.load-failed`, and `source.warning`.

## NDJSON event types

In JSON mode, `deploy` and `destroy` emit newline-delimited `WireReconcilerEvent` JSON objects (`EVENT_STREAM_VERSION = 1`) on `stdout`:

```ts [Protocol types]
export const EVENT_STREAM_VERSION = 1 as const;

export type WireReconcilerEvent = ReconcilerEvent & {
  version: typeof EVENT_STREAM_VERSION;
};
```

Each line carries `version: 1`, `level` (`"info" | "warn" | "error"`), and one of seven `event` discriminators:

| Event | Description |
| :--- | :--- |
| `reconciler.operation.lifecycle` | Tracks `create`, `read`, `update`, `delete`, `rotate`, and `load` steps |
| `reconciler.deploy.decision` | Reports the planned decision and replace order for a resource |
| `reconciler.drift.detected` | Emits the live `diff` record for a drifted resource |
| `reconciler.hold.waiting` | Warns that `executionId` is waiting on `holderExecutionId` |
| `reconciler.orphan-deletion.skipped` | Warns when an unregistered orphan and `keptDependencies` are skipped |
| `reconciler.provider.load-failed` | Warns when loading a `provider` package fails |
| `reconciler.source.warning` | Forwards a warning `message` from a credential source |

Lifecycle events include `operation`, `status` (`"start" | "success" | "error" | "skip" | "dry-run"`), `resourceId`, `resourceType`, and optional `reason` (`"taken-over" | "dependency-replaced" | "retired" | "read-not-implemented" | "not-created" | "key-unknown" | "passed"`), `replacedDependency`, `credential`, `errorName`, and `errorMessage`. Decision events include `resourceId`, `resourceType`, `decision` (`"create" | "update" | "replace" | "drift-update" | "drift-replace" | "drift-recreate" | "noop"`), optional `replaceFields`, `replaceOrder` (`"create-first" | "delete-first"`), and `placeholder: true`. See [Event Protocol](../internals/protocol.md) for wire encoding details.
