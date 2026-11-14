# Secrets

A secret is a reference to a value that lives in a secret store, such as Cloudflare's Secrets Store. Notation writes the value to the store when it creates or updates the secret, or, for a [produced source](#writing-a-producer), when it creates the resource that produces the value. It never records the value, or anything derived from it, in state, the journal, plan output or events.

A provider package declares secrets. See [Cloudflare secrets](../providers/cloudflare/secrets.md), and [`workerSecret`](../providers/cloudflare/workers.md#workersecretconfig) for a secret that a Worker binds as secret text.

## Sources

A secret takes its value from a source and a key, or from a prompt when it has no source. `@notation/std/sources` exports two sources:

| Source         | Reads                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| `env`          | `process.env`.                                                                           |
| `dotenv(path)` | One `.env` file. `path` is relative to the project root. A missing file counts as empty. |

Other sources are in their own packages, such as [`infisical()`](../providers/infisical/sources.md) from `@notation/infisical/sources`.

A secret can also take a produced source: a value that another resource gets only in the response to its create, such as the value of an API token. The resource exposes the value at `<producer>.sources.<name>`, such as `token.sources.value`, and the secret takes it without a `key`. That resource's create writes the value, and deploy never asks a source or a prompt for it. See [Produced sources](../providers/cloudflare/secrets.md#produced-sources).

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
| a produced source                      | none                      | when the producer is created or replaced             |

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

The prompt only fills a missing secret. When the secret already exists, such as after `notation secret set`, deploy records it without asking. See [notation secret](../cli/secret.md). A Worker secret can only be set on a Worker that exists, so a new Worker's first deploy without a terminal creates a placeholder Worker and fails. `notation secret set` then writes the value to the placeholder, and the next deploy goes on. See [the order of deploy](../providers/cloudflare/workers.md#order-of-deploy).

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

The reconciler removes every value that `getValue` returned from the errors of operations before it records them, in its raw, base64 and JSON-escaped forms, as a provider can echo a value back in an error. The CLI removes them from the error that it prints when a command fails.

## Writing a producer

A producer is a resource that gets a value only in the response to its create, and writes it to secrets. The `AccountToken` resource in `@notation/cloudflare` is one. Its group, `accountToken()`, is the example in this section. `@notation/core` exports the parts:

| Export                | Use                                                                          |
| --------------------- | ---------------------------------------------------------------------------- |
| `ProducedSource`      | The type of `<producer>.sources.<name>`.                                     |
| `SecretSource`        | `Source \| ProducedSource`, what a secret's `source` can be.                 |
| `producedSource()`    | Makes a produced source for a resource.                                      |
| `SecretTarget`        | Where a value is written: `{ provider, params }`.                            |
| `writeSecretValues()` | Writes values to targets, in the producer's create.                          |
| `registerSecretStore` | Registers the store implementation that writes to targets of one `provider`. |
| `isProducedSource()`  | Tells a produced source from a `Source`, in a secret's declaration.          |

### The targets param

The producer holds the secrets that it writes to in a collected param, as a list of `SecretTarget`. The param must be `immutable`, because only a create gets a value to write to a new target. So a change to the list replaces the producer, which is a rotation. The `AccountToken` resource calls the param `ValueTargets`:

```ts
ValueTargets: {
  propertyType: "param",
  presence: "required",
  immutable: true,
  value: v.array(v.object({ provider: v.string(), params: v.record(v.string(), v.any()) })),
  collect: (items: unknown[]) => items.flat() as SecretTarget[],
},
```

### `producedSource(options)`

The group makes one produced source for each value, and exposes it in a `sources` field. Name the field after the value, so that users write `<producer>.sources.<value>`:

```ts
this.sources = {
  value: producedSource({
    producer: `accountToken({ id: "${config.id}" })`,
    resource: this.token,
    name: "value",
    param: "ValueTargets",
  }),
};
```

| Option     | Meaning                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `producer` | Names the declaration in errors and in plan, such as `accountToken({ id: "deploy" })`.       |
| `resource` | The resource whose create writes the value. Each secret that takes the source depends on it. |
| `name`     | The name in `sources`, such as `value`.                                                      |
| `param`    | The collected param of `resource` that holds the targets.                                    |

The produced source holds `producer`, `resource` and a method `register(target)` under the key `"~producedSource"`. A secret's declaration calls `register` with its own target, and `register` contributes the target to `param` as a list of one. When the target holds output refs, such as the store's `StoreId`, the producer depends on the resources that they refer to. So deploy creates the store, then the producer, then the secret.

**When evaluation of the infra ends, collection throws if no secret registered a target with a produced source.** The value would otherwise be lost, because only the producer's create gets it. `producedSource` adds this check only while a resource graph is being collected.

### The create

The producer's create writes the value to each target with `writeSecretValues`, in the same step as the API call that returns the value:

```ts
create: async (params) => {
  const token = await createToken(/* ... */);
  try {
    await writeSecretValues(params.ValueTargets.map((target) => [target, token.value]));
  } catch (error) {
    await deleteToken(params.AccountId, token.id); // the value is lost, so delete the token
    throw error;
  }
  return { TokenId: token.id };
},
```

`writeSecretValues` takes a list of `[target, value]` pairs, and writes them in order:

1. It adds each value to the values that the reconciler removes from errors, as `getValue` does.
2. It looks up the store that is registered for each target's `provider`, and calls its `write` with the target's `params`. It throws if no store is registered for the provider.
3. When a write fails, it deletes the values that it wrote before, and throws an error that says a secret may now be empty. When the first write fails, it throws that error as it is.

The other operations of a producer follow from the fact that the secrets own the value:

- `read` doesn't check the secrets. The secret's own read reports a missing secret as drift. A producer that threw on it would fail the plan before plan shows the drift.
- `delete` removes only the producer's remote resource, and leaves the secrets. In a rotation, the old producer's delete would otherwise delete the value that its replacement wrote.

### The secret

A secret's declaration accepts a `SecretSource`, and checks it with `isProducedSource`. For a produced source, the Cloudflare `secret()` does this:

- It calls `register` with the target `{ provider: "@notation/cloudflare/resources", params: { AccountId, StoreId, Name } }`, where `AccountId` and `StoreId` are output refs of the store.
- It records `ValueFrom: { Secret: id, Source: "produced", Producer }`. `"produced"` is `PRODUCED_SOURCE` from `@notation/core`. Plan finds the secrets that a replace of a producer rotates by this value.
- It makes the secret depend on the producer's resource.
- It declares the secret with no `set`, so `notation secret set` refuses it and names the producer.

The secret's create writes nothing. It finds the secret by name and records it, or fails and names the producer when the secret is missing. Its update writes nothing. Its delete deletes the secret, as for any other source.

### `registerSecretStore(provider, store)`

A provider package registers the store that writes to its targets when the module of its secret resource loads. The resource registry loads that module for a secret's record that is no longer in code, so a producer whose secrets were removed still finds the store.

```ts
registerSecretStore("@notation/cloudflare/resources", {
  write: (params, value) => /* create the secret, or overwrite its value */,
  delete: (params) => /* succeed when the secret is already gone */,
  has: (params) => /* true when the secret exists */,
});
```

The stores are kept on `globalThis`, so that each copy of `@notation/core` in a process, such as the infra bundle's and the CLI's, finds the same stores.
