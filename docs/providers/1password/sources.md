# 1Password

`@notation/1password` reads secrets from 1Password during `plan` and `deploy`, and passes them to AWS, Cloudflare or custom Notation resources. It has one credential source, `OnePasswordSecret`. Secret values do not go into state, plans or error output.

## Installation

`@notation/1password` reads items with the 1Password CLI, `op`. Install `op` on every machine and CI runner that runs `plan` or `deploy`. See 1Password's [install guide](https://developer.1password.com/docs/cli/get-started/). The package is tested with `op` 2.32.0.

Then install the package next to `@notation/core` and your cloud provider package:

```sh [Terminal]
@pm.add("@notation/1password")
```

## Quickstart

Declare a `OnePasswordSecret` in an infrastructure module for each secret, and pass its `.credentials.value` to an AWS Lambda function:

::code-group

```ts [infra/secrets.ts]
import { OnePasswordSecret } from "@notation/1password/resources";

export const stripeKey = new OnePasswordSecret("stripe-key", {
  config: { reference: "op://Prod/Stripe/api key", track: "hmac" },
});

export const databaseUrl = new OnePasswordSecret("database-url", {
  config: {
    reference: "op://Prod/Orders database/connection/url",
    track: "hmac",
  },
});
```

```ts [runtime/checkout.ts]
import { $lambda, type LambdaHandler } from "@notation/aws/lambda";
import { databaseUrl, stripeKey } from "../infra/secrets";

export const checkout = $lambda({
  id: "checkout",
  env: () => ({
    STRIPE_KEY: stripeKey.credentials.value,
    DATABASE_URL: databaseUrl.credentials.value,
  }),
});

export const handler: LambdaHandler<typeof checkout> = async () => {
  const { STRIPE_KEY } = checkout.env();
  return { statusCode: 200, body: STRIPE_KEY ? "configured" : "missing" };
};
```

::

`reference` is a 1Password secret reference. You can copy it from the 1Password app: open the item, click the field, and choose **Copy Secret Reference**. `track: "hmac"` needs a `NOTATION_TRACK_KEY`. See [Change tracking](#change-tracking).

`.credentials.value` can also go into a Cloudflare [`$worker`](../cloudflare/workers.md) in `bindings`, or into a Cloudflare [`SecretsStoreSecret`](../cloudflare/secrets.md), in the same way as for [Infisical](../infisical/sources.md#cloudflare-secrets-store).

## Secret references

A secret reference names one field of one item:

```txt
op://<vault>/<item>/[<section>/]<field>
```

For example, `op://Prod/Orders database/connection/url` names the field `url` in the section `connection` of the item `Orders database` in the vault `Prod`. The constructor of `OnePasswordSecret` parses the reference, and throws if the syntax is wrong. The error starts with "`<reference>` is not a 1Password reference that notation can read", and gives the reason.

Each part of a reference can be a name or an ID. An ID is 26 characters of lower-case letters and digits, such as `k3vnt5xbj2qyw6dhm4ra7cpzlu`.

| | Names | IDs |
| :--- | :--- | :--- |
| Example | `op://Prod/Stripe/api key` | `op://y4c2…/k3vn…/9wqa…` |
| After a rename | The reference fails | The reference keeps working |
| Two items with the same name | The reference fails | Cannot happen |
| In another 1Password account | Can match a different item | Cannot match |

Use IDs for references that must keep working, and for references that must not match an item in another account. See [Accounts](#accounts).

These rules apply to the field:

- **With a section**, only fields in that section match.
- **Without a section**, the field must match exactly one field of the item. If a label is used in two sections, add the section to the reference.
- **Field errors.** When no field matches, or more than one matches, the error lists the reference of each field of the item. It lists no values.
- **Files** attached to an item are not supported. The reference fails as a missing field.

The constructor rejects two kinds of reference:

- **Query attributes**, such as `?attribute=otp` or `?ssh-format=openssh`. A one-time password changes every 30 seconds, so there is no fixed value to deploy.
- **Item names that start with `-`.** Use the item's ID instead.

For a reference that `op read` resolves, `OnePasswordSecret` returns the same value as `op read`, or fails. It never returns a different value.

As an aside, a reference to the `Private` or `Personal` vault names a different vault for each developer. It works, but each developer deploys their own value, and a service account can't read it.

## Change tracking

Notation keeps a `revision` for each source in state, and updates the resources that take the secret when the revision changes. The `track` option chooses what the revision is:

| `track` | Revision | Consumers are updated when |
| :--- | :--- | :--- |
| not set | The item's ID and version | Any part of the item changes |
| `"hmac"` | A keyed HMAC-SHA256 hash of the field's value | The field's value changes |
| `"scrypt"` | A salted scrypt hash of the field's value | The field's value changes |

**Use `track: "hmac"` for any item that people edit.** 1Password keeps one version for the whole item, not one for each field. Without `track`, a change to another field, to the title or to the tags of the item raises the version, and Notation updates every consumer with the same value. A change to the item in the middle of a deploy can also fail the deploy when it continues after a resume or a retry delay. See [Errors](#errors).

`"hmac"` needs the same `NOTATION_TRACK_KEY` on every machine and CI runner that runs `plan` or `deploy`:

```sh [Terminal]
export NOTATION_TRACK_KEY="your-shared-track-key"
```

Use `"scrypt"` only for values that a machine generated, such as a random API key.

## Signing in

`OnePasswordSecret` has no sign-in settings of its own. `op` signs in, and it chooses one of three ways from the environment:

| Way | Environment | Typical use |
| :--- | :--- | :--- |
| 1Password desktop app | none | A developer at their own machine |
| Service account | `OP_SERVICE_ACCOUNT_TOKEN` | CI, and agents that work alone |
| Connect server | `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` | A self-hosted Connect server |

The package does not fall back from one way to another. For example, if `OP_SERVICE_ACCOUNT_TOKEN` is set but not valid, `op` fails with `error initializing client`, and does not ask the desktop app. A fallback could let a deploy read from vaults that you did not mean to give it.

### Accounts

`OnePasswordSecret` has no account param. `op` uses the account in `OP_ACCOUNT`, or else the account you signed in to last.

If you are signed in to two accounts, for example a personal one and a work one, set `OP_ACCOUNT`:

```sh [Terminal]
export OP_ACCOUNT="acme.1password.com"
```

Without `OP_ACCOUNT`, `op` can look up a reference with names in the wrong account. When `op` signs in with the desktop app, and can't find a vault or an item, the error says which account `op` used. When more than one item has the name, the error says to use the item's ID in the reference.

All sources in one `plan` or `deploy` read from one account. Sources in two accounts need two deploys, or references with IDs and a Connect server.

## Approval prompts

With the desktop app, `op` asks you to approve access the first time it runs in a terminal session. The prompt appears in the 1Password app, not in the terminal. An approval lasts for that terminal session, and covers every process that the session starts, until it expires.

Notation fetches the `OnePasswordSecret` sources at the start of `plan` and `deploy`, before it changes any resource. So you see at most one prompt for each command, right after you run it. While `op` waits for you, the output shows:

```txt
… Waiting for 1Password. Approve the request in the 1Password app. (1password/secrets/OnePasswordSecret)
```

`op` waits up to 60 seconds, and then fails with `authorization timeout`. In a plan, or at the start of a deploy, nothing has changed at that point.

- **At a terminal**, you approve once. Later plans and deploys in the same terminal session run without a prompt until the approval expires.
- **`notation watch`** fetches every item on each deploy, so each deploy takes at least 1.3 seconds longer. The deploys run in the terminal session of `notation watch`, so one approval covers them.
- **A deploy that continues** fetches every item again, and so can show a prompt. This happens when a deploy is resumed, and when it wakes after a retry delay.
- **A deploy that waits for another deploy to finish** fetches the items only after the other deploy has finished. It shows no prompt while it waits.
- **A source that depends on another resource** is not fetched at the start. This includes a source whose `reference` is built from another resource's output. Notation fetches its item when it reads the source, in the middle of the plan or deploy. If the approval has expired by then, the prompt appears at that point.

With `OP_SERVICE_ACCOUNT_TOKEN` or `OP_CONNECT_HOST` set, there is no prompt, and the output does not show the message.

### Agents

A coding agent usually runs each command in a new terminal session, so each `plan` and `deploy` shows a new prompt, and a person must approve it within 60 seconds. For an agent that works without a person, use a service account. See [CI with a service account](#ci-with-a-service-account); the same setup applies.

On Windows, 1Password's docs say that each sub-shell needs its own approval. This has not been tested. If it is so, `notation watch` shows a prompt for each deploy on Windows.

## CI with a service account

> [!WARNING]
> The service account setup has not been checked with a real service account yet. Only the case of an invalid token has been tested.

To plan and deploy in CI, create a 1Password service account, give it the vaults that your references name, and set `OP_SERVICE_ACCOUNT_TOKEN` in the job. The job must install `op`, for example with 1Password's `install-cli-action`:

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

The references in `infra/` stay the same. With a token, `op` never asks the desktop app, so there is no prompt.

A service account reads only the vaults that you gave it. It can't read a `Personal`, `Private` or `Employee` vault, or the default `Shared` vault. **A reference that works on your machine can therefore fail in CI.** The deploy fails at its start, before it changes anything, and the error lists every source that could not be fetched.

A reference names one vault, so a source reads the same item on your machine and in CI only if you and the service account can both read that vault. For example, a team that deploys `prod` only from CI can give the `Prod` vault only to the service account. A developer who runs `notation plan --stage prod` on their machine then gets an error. To use a different vault for each stage, choose the reference by stage in `infra/`:

```ts [infra/secrets.ts]
import { deployment } from "@notation/core";
import { OnePasswordSecret } from "@notation/1password/resources";

const vault = deployment().stage === "prod" ? "Prod" : "Dev";

export const stripeKey = new OnePasswordSecret("stripe-key", {
  config: { reference: `op://${vault}/Stripe/api key`, track: "hmac" },
});
```

### Rate limits

> [!WARNING]
> These numbers are 1Password's published limits. It is not confirmed yet how 1Password counts the calls that `@notation/1password` makes.

Every `plan` and every `deploy` fetches every item once, with one `op` call for each item. A job that runs `plan` and then `deploy` fetches each item twice. 1Password limits service accounts in two ways:

| Plan | Reads per token per hour | Requests per account per day |
| :--- | :--- | :--- |
| Business | 10,000 | 50,000 |
| Teams | 1,000 | 5,000 |
| Families | 1,000 | 1,000 |

For example, if each call counts as one read, a job with 20 items that plans and deploys makes 40 reads. On Teams, it can run 25 times an hour. On Families, it can run 25 times a day.

## Without the package

If you can't install `@notation/1password`, you can run Notation under `op run` and read each secret with [`sources.Env`](../../core/secrets.md) from `@notation/std`. List the secrets in an env file:

```sh [.env.op]
STRIPE_KEY="op://Prod/Stripe/api key"
```

Read the variable with `sources.Env`, and set `track`, because an environment variable has no version:

```ts [infra/secrets.ts]
import { sources } from "@notation/std/resources";

export const stripeKey = new sources.Env("stripe-key", {
  config: { key: "STRIPE_KEY", track: "hmac" },
});
```

Then run the command under `op run`:

```sh [Terminal]
op run --env-file .env.op -- notation deploy
```

This names each secret twice, once in `.env.op` and once in `infra/`. A resumed deploy also needs `op run` again.

## Reference

### OnePasswordSecret

`OnePasswordSecret` (`1password/secrets/OnePasswordSecret`) from `@notation/1password/resources` is a read-only credential source. It never writes to 1Password. Removing it from code deletes only its Notation state record.

#### Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `reference` | `string`, required | An `op://` secret reference. See [Secret references](#secret-references). |
| `track` | `"hmac"` or `"scrypt"`, optional | Makes the revision a hash of the field's value. See [Change tracking](#change-tracking). |

#### Properties

- **`revision`** (`string`, computed) – `version:<item id>:<item version>` without `track`, or `hmac:<hex>` or `scrypt:<hex>` with `track`. Notation stores it in state. It contains no value.
- **`credentials.value`** (`CredentialRef<string>`, credential) – The value of the field, as a [credential reference](../../core/secrets.md) for consumer resources.

### Errors

A `plan` or `deploy` fails at its start when a source can't be fetched. The error lists every such source:

```txt
2 sources could not be fetched.
  stripe-key (1password/secrets/OnePasswordSecret): <message>
  database-url (1password/secrets/OnePasswordSecret): <message>
```

Other errors:

- **`op` is not installed.** The error is "The 1Password CLI, op, is required, and it isn't on PATH", followed by a link to the install guide.
- **`authorization timeout`.** Nobody approved the prompt within 60 seconds. The error adds that a process with no person to approve the prompt, such as an agent or a CI job, needs a 1Password service account in `OP_SERVICE_ACCOUNT_TOKEN`.
- **The item is archived.** The source fails. `op` still finds an archived item by its ID, so without this check a reference with IDs would keep deploying it.
- **The value is empty.** The source fails.
- **The item changed during a deploy.** Without `track`, a deploy that continues after a resume or a retry delay fails if the item has a new version, with a message that ends "changed after deploy read it. Run deploy again." `op` can't fetch a past version of an item, so the deploy can't load the value that it read before. Run `deploy` again.
- **`ItemReplacedError`.** The item was deleted, and another item with the same name was added, during a deploy. The message ends "was deleted and another item with the same name was added after deploy read it. Run deploy again."
- **`OnePasswordError`.** Any other failed `op` call, with the message `op failed with exit code <code>: <message>`. `<message>` is what `op` printed on stderr, without the `[ERROR]` prefix and the timestamp at the start of each line. It has `exitCode` and `stderr`, which holds the text that `op` printed, with secret values scrubbed.
- **Output that Notation can't read.** If `op` prints output that is not the expected JSON, the error is "1Password returned output that notation can't read." The output itself is never included, because it contains values.

`@notation/1password/resources` exports `OnePasswordError` and `ItemReplacedError`.

### Limits

- **Item and vault names are visible in the process list.** They are arguments of `op`, so other users of the machine can see them. No value is ever an argument.
- **Fetched values stay in memory** until the `plan` or `deploy` ends. These are the values of the fields that sources name.
- **The desktop app prompt is not tested on Linux.** 1Password's docs say it behaves as on macOS.
