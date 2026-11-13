# Secrets

A secret is a reference to a value that lives in a secret store, such as Cloudflare's Secrets Store. Notation writes the value to the store when it creates or updates the secret. It never records the value, or anything derived from it, in state, the journal, plan output or events.

A provider package declares secrets. See [Cloudflare secrets](../providers/cloudflare/secrets.md).

## Sources

A secret takes its value from a source and a key, or from a prompt when it has no source. `@notation/std/sources` exports two sources:

| Source         | Reads                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `env`          | `process.env`.                                                                           |
| `dotenv(path)` | One `.env` file. `path` is relative to the project root. A missing file counts as empty. |

Other sources are in their own packages, such as [`infisical()`](../providers/infisical/sources.md) from `@notation/infisical/sources`.

```ts [infra/secrets.ts]
import { secret } from "@notation/cloudflare/secrets-store";
import { dotenv, env } from "@notation/std/sources";

export const sentryDsn = secret({
  id: "sentry-dsn",
  source: env,
  key: "SENTRY_DSN",
});

export const webhookSecret = secret({
  id: "webhook-secret",
  source: dotenv(".env.local"),
  key: "WEBHOOK_SECRET",
});

// No source: deploy asks for the value, or `notation secret set` sets it.
export const adminPassword = secret({ id: "admin-password" });
```

Each secret with a source has a `SourceValue` resource, with the ID `value:<id>`. It records the secret's id, the source's name, the key, and a version, and never the value. Plan and deploy fail when the source doesn't have the key:

```text
`SENTRY_DSN` isn't in the env source of `sentry-dsn`.
```

## When a value is written

A secret is written when its version changes:

| Source                                 | Version                   | The secret is written                                |
| -------------------------------------- | ------------------------- | ---------------------------------------------------- |
| A versioned one, such as `infisical()` | the source's version      | when the version changes                             |
| `env`, `dotenv`                        | the deploy's execution ID | on every deploy                                      |
| none (prompt)                          | none                      | when the secret is created, or recreated after drift |

`env` and `dotenv` have no versions, so plan shows an update of their `SourceValue` on every run. The same applies to a key that a versioned source gives no version, such as an `infisical()` secret that references another secret. A move from one source to another writes the secret from the new source.

A value changed in the store by hand stays until the next write.

## The prompt

A secret without a source takes its value from a prompt:

- On a terminal, deploy asks for the value with a hidden prompt, in the secret's own step.
- With no terminal, or with `--json`, deploy fails:

  ```text
  Secret `admin-password` isn't set for stage dev. Run `notation secret set admin-password --stage dev`.
  ```

- `notation watch` asks at each deploy that needs the value. It doesn't keep the answer between deploys.
- Plan never asks. It notes that deploy will ask, or fail without a terminal.

The prompt only fills a missing secret. When the secret already exists, such as after `notation secret set`, deploy records it without asking. See [notation secret](../cli/secret.md).

## Writing a source

A source is a plain object that implements `Source`, from `@notation/std/sources`:

```ts
type Source = {
  /** Shown in plan, and stored in the value resource's params. */
  name: string;
  /** True if the source has a value for the key. */
  has(key: string, context: { stage: string }): Promise<boolean>;
  /** The key's version. Left out by sources that have no versions. */
  version?(
    key: string,
    context: { stage: string },
  ): Promise<string | undefined>;
  get(key: string, context: { stage: string }): Promise<Redacted<string>>;
};
```

- `version` returns a number or ID that the source assigns, such as a secrets manager's version of the key. It must never be a hash of the value. It returns `undefined` for a key that has no stable version. The deploy's execution ID is then used, so the secret is written on every deploy.
- `get` returns the value in a `Redacted`, from `@notation/std/sources`.
- A source may cache within one process. For example, it can fetch a folder once and answer every call from that response.
- A source reads its own credentials from `process.env`.

A package that has sources exports them from a `/sources` subpath, as `@notation/std/sources` does.

## `Redacted`

`Redacted` holds a secret value, so that it isn't sent or printed by accident:

| Use                                                      | Result               |
| -------------------------------------------------------- | -------------------- |
| `` `Bearer ${value}` ``, `String(value)`, `value + ""`   | throws               |
| `JSON.stringify({ value })`                              | throws               |
| `console.log(value)`, and a value inside a printed error | `Redacted(<hidden>)` |
| `value.unwrap()`                                         | the string           |

## Writing the value in a resource

A resource that writes a secret's value calls `getValue(id)` from `@notation/std/sources` in its `create` and `update`, with the id of the secret's declaration. It calls the secret's source, or the prompt. This is the pattern of a Lambda function, which reads its code from a `File` resource when it uploads.

The CLI removes every value that `getValue` returned from what it prints, in its raw, base64 and JSON-escaped forms. The reconciler removes them from the errors of operations before it records them, as a provider can echo a value back in an error.
