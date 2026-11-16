# Secrets

A secret value, such as a Stripe API key, reaches a deployed resource as a **credential**. Deploy holds the value of a credential in memory only. It puts the value in the params of the resource that takes it for the call to the provider, and nowhere else. State, the journal, plan output and events hold a marker in place of the value.

## Credentials

A credential is an output of a resource. Two kinds of resource have credentials:

| Kind     | Example                                   | Where the value comes from                                               |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Resource | `tokens.AccountToken`, credential `Value` | The provider returns it when it creates the token, and when it rolls it. |
| Source   | `sources.Env`, credential `value`         | A place outside Notation, such as an environment variable.               |

Another resource takes the value with `resource.credentials.<name>`. In this example, the key is read from the environment variable `STRIPE_KEY`, written to the Cloudflare Secrets Store, and bound to a Worker:

```ts [infra/secrets.ts]
import { secretsStore } from "@notation/cloudflare/resources";
import { sources } from "@notation/std/resources";

const store = new secretsStore.SecretsStore("store");

const stripeKey = new sources.Env("stripe-key", {
  config: { key: "STRIPE_KEY" },
});

export const stripeKeySecret = new secretsStore.SecretsStoreSecret(
  "stripe-key-secret",
  {
    config: { Value: stripeKey.credentials.value }, // ← the credential
    dependencies: { store },
  },
);
```

`stripeKey.credentials.value` is an [output ref](../reference/resource.md#output-refs). It makes `stripe-key-secret` depend on `stripe-key`, and deploy puts the value in its place when it creates or updates the secret. Each value follows a param, so the graph shows where it goes:

```text
store                SecretsStore
stripe-key           Env                  credentials: { value }
stripe-key-secret    SecretsStoreSecret   Value ← stripe-key.value
```

One credential can go to several resources. A Worker can also take the same value as a Worker secret. See [Cloudflare secrets](../providers/cloudflare/secrets.md) and [Worker secrets](../providers/cloudflare/workers.md#worker-secrets).

## Sources

A source is a resource that supplies a value that exists outside Notation. Deploy creates nothing at a provider for a source, and never replaces one. Each source has one credential, `value`.

| Class             | Package                         | Config                                    | Reads                                                                                            |
| ----------------- | ------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sources.Env`     | `@notation/std/resources`       | `key`                                     | The environment variable `key`.                                                                  |
| `sources.Dotenv`  | `@notation/std/resources`       | `path`, `key`                             | The key in one `.env` file. `path` is relative to the project root. A missing file holds no key. |
| `InfisicalSecret` | `@notation/infisical/resources` | `projectId`, `environment`, `path`, `key` | One secret in Infisical. See [Infisical](../providers/infisical/sources.md).                     |

Each of the three also takes `track`. See [Tracking a value](#tracking-a-value).

```ts [infra/secrets.ts]
import { InfisicalSecret } from "@notation/infisical/resources";
import { sources } from "@notation/std/resources";

new sources.Env("sentry-dsn", {
  config: { key: "SENTRY_DSN" },
});

new sources.Dotenv("webhook-secret", {
  config: { path: ".env.local", key: "WEBHOOK_SECRET" },
});

new InfisicalSecret("stripe-key", {
  config: {
    projectId: "4f2a…",
    environment: "prod",
    path: "/orders",
    key: "STRIPE_KEY",
  },
});
```

The config keys of the sources are in camel case. The Cloudflare resources keep their Pascal case keys, so one line can hold both: `{ Value: stripeKey.credentials.value }`.

The state record of a source holds its params, its `revision` and a marker for the credential. It never holds the value:

```json
{
  "id": "stripe-key",
  "type": "std/sources/Env",
  "params": { "key": "STRIPE_KEY" },
  "output": {
    "key": "STRIPE_KEY",
    "revision": "0195f0c2-7d1e-7b4a-9c3e-2f6a8b1d4e70",
    "value": {
      "$credential": {
        "resource": "stripe-key",
        "name": "value",
        "version": "7b1e52c0…"
      }
    }
  }
}
```

When a source is removed from code, deploy deletes its record and calls nothing else.

Keep the source's provider package installed for the deploy that removes the source. If the package is removed in the same change, deploy cannot load the provider, warns that the provider load failed, and leaves the record in state. Remove the package after that deploy.

## When a value is written

Plan and deploy call the `read` operation of every source. `read` returns the source's `revision`, and never the value. The credential's version is a hash of the source's ID, its params and its `revision`, so a change to either gives the credential a new version. Deploy then updates every resource that takes the credential.

The `revision` of each source:

| Source                                          | `revision`                  | A resource that takes the value is written |
| ----------------------------------------------- | --------------------------- | ------------------------------------------ |
| `InfisicalSecret`                               | the secret's ID and version | when the version changes                   |
| `InfisicalSecret` that refers to another secret | the deploy's execution ID   | on every deploy                            |
| `Env`, `Dotenv`                                 | the deploy's execution ID   | on every deploy                            |
| any source with `track`                         | a hash of the value         | when the value changes                     |

So without `track`, an `Env` shows a change in every plan:

```text
~ update std/sources/Env stripe-key
~ update cloudflare/secrets-store/SecretsStoreSecret stripe-key-secret
```

Deploy gets the value with the source's `loadCredential` operation. It calls `loadCredential` only when a resource that takes the value is created or updated, and only once in a deploy. `loadCredential` fails for an empty value.

- **A source that no resource takes is never loaded.** Its variable need not be set.
- **Without `track`, `Env` and `Dotenv` are loaded on every deploy,** because each deploy has a new revision and updates every resource that takes the value. The variable must be set on every machine that deploys, including CI.
- **Loading a value again changes no other resource.** For example, when drift detection finds that the store secret `stripe-key-secret` was deleted, deploy creates it again, and loads the value for the source's current revision. If the revision did not change, the credential keeps its version, so no other resource that takes it is written.

A value changed at the provider by hand, such as in the Cloudflare dashboard, stays until the next write.

## Tracking a value

`Env` and `Dotenv` have no version of their own. `track` makes the `revision` a hash of the value, so plan shows a change only when the value changed. It takes one of two algorithms:

```ts [infra/secrets.ts]
// For a generated value, such as an API key. Needs no setup.
new sources.Env("stripe-key", {
  config: { key: "STRIPE_KEY", track: "scrypt" },
});

// For any value, including a password that a person chose. Needs a key.
new sources.Env("admin-password", {
  config: { key: "ADMIN_PASSWORD", track: "hmac" },
});
```

|                         | `"scrypt"`                                                    | `"hmac"`                                                     |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `revision`              | `scrypt:<hex>`                                                | `hmac:<hex>`                                                 |
| Setup                   | none                                                          | `NOTATION_TRACK_KEY` on every machine                        |
| Cost at plan            | about 0.25 seconds and 128 MiB for each source, one at a time | none                                                         |
| Someone who reads state | can test guesses, slowly                                      | can test nothing without the key                             |
| The key is missing      |                                                               | plan and deploy fail, and name the variable                  |
| The key changes         |                                                               | every tracked value gets a new revision, and is written once |

**`"scrypt"` is for generated values only.** A person who reads state can test a guess against a scrypt hash. At about 15 guesses a second on a laptop, a 4-digit PIN takes minutes and a common password takes about a day. A generated API key cannot be guessed. Use `"hmac"` for a value that a person chose.

Make the key for `"hmac"` once, and keep it where the team keeps its other deploy credentials. Every plan and deploy must use the same key:

```sh
# Once, by one person. Store the output, for example as a CI secret.
openssl rand -hex 32

# On every machine that plans or deploys, with the stored key.
export NOTATION_TRACK_KEY="4c1f…"
```

The hash is salted with the app, the stage and the source's ID, so state does not show that two sources have the same value. `track` is off by default. Without it, state holds nothing that is derived from the value.

With `track`, deploy checks the value again when it loads it. If the hash is not the `revision` that `read` returned, the value changed after `read`, and deploy fails:

```text
The value of stripe-key changed after deploy read it. Run deploy again.
```

### When the value is not set

With `track`, `read` reads the value, so plan needs the variable. When the variable is not set, `read` returns the `revision` in state, and plan warns:

```text
! stripe-key std/sources/Env STRIPE_KEY is not set. Its value was not checked for a change.
```

| The variable is not set, and                        | Plan and deploy                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| state has a `revision`, no resource needs the value | warn, and show no change for the source                              |
| state has a `revision`, a resource needs the value  | plan warns; deploy fails at `loadCredential`, and names the variable |
| state has no `revision`                             | fail, and name the variable                                          |

So a machine without the variable can plan and deploy other changes, but it cannot detect a change of the value.

With `track: "hmac"`, plan and deploy need `NOTATION_TRACK_KEY` even when the variable is not set. Without it, they fail and name `NOTATION_TRACK_KEY`.

## A value that depends on the stage

A resource's config becomes its params, which state records and plan compares, so config cannot hold a function of the stage. To pick a value by stage, call `deployment()` from `@notation/core`. It returns the app and the stage that the infra code is being evaluated for:

```ts [infra/secrets.ts]
import { deployment } from "@notation/core";
import { InfisicalSecret } from "@notation/infisical/resources";

const { stage } = deployment();

new InfisicalSecret("stripe-key", {
  config: {
    projectId: "4f2a…",
    environment: stage === "prod" ? "prod" : "dev",
    path: "/orders",
    key: "STRIPE_KEY",
  },
});
```

- `deployment()` works in the config of any resource.
- The value is a plain string by the time it is a param, so plan shows it and state records it.
- Plan, deploy, destroy, watch and `notation viz` evaluate the infra code for a stage. Outside that evaluation, `deployment()` throws.

## A credential that the provider issues once

Some providers return a value once, at create, and have no API to issue another. The resource declares such a credential without a `rotate` operation. When a resource needs the value and deploy holds none, plan and deploy fail, and print two commands: one that replaces the resource, and one that passes a value that you hold. See [notation deploy](../cli/deploy.md#a-credential-that-deploy-cannot-get).

A source never needs this. Deploy can always load its value again.

## Values in errors

A provider can echo a value back in an error. The reconciler removes the value of every credential, and every value that a source read, from the errors of operations before it records them, in its raw, base64 and JSON-escaped forms. The CLI removes them from the error that it prints when a command fails.

## Writing a source

A source class is built with `credentialSourceResource()` from `@notation/resource`. See [Credential sources](../reference/resource.md#credential-sources).
