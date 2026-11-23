# 1Password

`@notation/1password` reads secrets from 1Password during `plan` and `deploy`, and passes them to AWS, Cloudflare or custom Notation resources. Secret values do not go into state, plans or error output.

## Installation

`@notation/1password` reads items with the 1Password CLI, `op`. Install `op` on every machine and CI runner that runs `plan` or `deploy`. See 1Password's [install guide](https://developer.1password.com/docs/cli/get-started/).

Then install the package next to `@notation/core` and your cloud provider package:

```sh [Terminal]
@pm.add("@notation/1password")
```

## Quickstart

Declare a `OnePasswordSecret` for each secret, and pass its `.credentials.value` to an AWS Lambda function:

::code-group

```ts [infra/secrets.ts]
import { OnePasswordSecret } from "@notation/1password/resources";

export const stripeKey = new OnePasswordSecret("stripe-key", {
  config: { reference: "op://Prod/Stripe/api key", track: "hmac" },
});
```

```ts [runtime/checkout.ts]
import { $lambda, type LambdaHandler } from "@notation/aws/lambda";
import { stripeKey } from "../infra/secrets";

export const checkout = $lambda({
  id: "checkout",
  env: () => ({
    STRIPE_KEY: stripeKey.credentials.value,
  }),
});

export const handler: LambdaHandler<typeof checkout> = async () => {
  const { STRIPE_KEY } = checkout.env();
  return { statusCode: 200, body: STRIPE_KEY ? "configured" : "missing" };
};
```

::

`.credentials.value` can also go into a Cloudflare [`$worker`](../cloudflare/workers.md) in `bindings`, or into a Cloudflare [`SecretsStoreSecret`](../cloudflare/secrets.md), in the same way as for [Infisical](../infisical/sources.md#cloudflare-secrets-store).

## Secret references

`reference` names one field of one item:

```txt
op://<vault>/<item>/[<section>/]<field>
```

To copy a reference, open the item in the 1Password app, click the field, and choose **Copy Secret Reference**.

Each part can be a name or an ID. A reference with names fails when someone renames the item, or when two items have the same name. A reference with IDs keeps working.

## Change tracking

Notation updates the resources that take a secret when the source's `revision` changes. The `track` option chooses what the revision is:

| `track` | Consumers are updated when |
| :--- | :--- |
| not set | Any part of the item changes |
| `"hmac"` | The field's value changes |
| `"scrypt"` | The field's value changes |

**Use `track: "hmac"` for any item that people edit.** 1Password keeps one version for the whole item. Without `track`, an edit to another field or to the title updates every consumer with the same value.

`"hmac"` needs the same `NOTATION_TRACK_KEY` on every machine and CI runner that runs `plan` or `deploy`:

```sh [Terminal]
export NOTATION_TRACK_KEY="your-shared-track-key"
```

Use `"scrypt"` only for values that a machine generated, such as a random API key.

## Signing in

`op` signs in, and chooses how from the environment:

| Way | Environment | Typical use |
| :--- | :--- | :--- |
| 1Password desktop app | none | A developer at their own machine |
| Service account | `OP_SERVICE_ACCOUNT_TOKEN` | CI, and agents that work alone |
| Connect server | `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` | A self-hosted Connect server |

If you are signed in to more than one account, set `OP_ACCOUNT`. Otherwise `op` uses the account you signed in to last:

```sh [Terminal]
export OP_ACCOUNT="acme.1password.com"
```

### Approval prompts

With the desktop app, the 1Password app asks you to approve access the first time `op` runs in a terminal session. Notation fetches every item at the start of `plan` and `deploy`, so you see at most one prompt, before anything changes. While it waits, the output shows:

```txt
… Waiting for 1Password. Approve the request in the 1Password app. (1password/secrets/OnePasswordSecret)
```

The approval lasts for the terminal session. If nobody approves within 60 seconds, the command fails with `authorization timeout`.

A coding agent usually runs each command in a new terminal session, so each command shows a new prompt. For an agent that works without a person, use a service account.

## CI with a service account

Create a 1Password service account, give it the vaults that your references name, and set `OP_SERVICE_ACCOUNT_TOKEN` in the job:

```yaml [.github/workflows/deploy.yml]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: 1password/install-cli-action@v1
      - run: notation deploy --stage prod
        env:
          OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
          NOTATION_TRACK_KEY: ${{ secrets.NOTATION_TRACK_KEY }}
```

A service account can't read `Personal`, `Private` or `Employee` vaults, or the default `Shared` vault. **So a reference that works on your machine can fail in CI.** To use a different vault for each stage, choose the reference by stage:

```ts [infra/secrets.ts]
import { deployment } from "@notation/core";
import { OnePasswordSecret } from "@notation/1password/resources";

const vault = deployment().stage === "prod" ? "Prod" : "Dev";

export const stripeKey = new OnePasswordSecret("stripe-key", {
  config: { reference: `op://${vault}/Stripe/api key`, track: "hmac" },
});
```

Each `plan` and `deploy` makes one `op` call for each item. 1Password limits how many reads a service account can make each hour and each day, and the limits depend on your plan.

## Reference

### OnePasswordSecret

`OnePasswordSecret` (`1password/secrets/OnePasswordSecret`) from `@notation/1password/resources` is a read-only credential source. It never writes to 1Password. Removing it from code deletes only its Notation state record.

#### Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `reference` | `string`, required | An `op://` secret reference. See [Secret references](#secret-references). |
| `track` | `"hmac"` or `"scrypt"`, optional | Updates consumers only when the field's value changes. See [Change tracking](#change-tracking). |

#### Properties

- **`revision`** (`string`, computed) – Stored in state. It contains no value.
- **`credentials.value`** (`CredentialRef<string>`, credential) – The value of the field, as a [credential reference](../../core/secrets.md) for consumer resources.

### Errors

When some items can't be fetched, `plan` and `deploy` fail at the start and list each source:

```txt
2 sources could not be fetched.
  stripe-key (1password/secrets/OnePasswordSecret): <message>
  database-url (1password/secrets/OnePasswordSecret): <message>
```

`@notation/1password/resources` exports two error classes:

- **`OnePasswordError`** – An `op` call failed. It has `exitCode` and `stderr`, with secret values scrubbed.
- **`ItemReplacedError`** – The item was deleted and another item with the same name was added during a deploy. Run `deploy` again.

Without `track`, a deploy that is resumed also fails if the item changed since the deploy read it, because `op` can't fetch an old version. Run `deploy` again.
