# Secrets

Notation wires external secrets and provider-minted credentials into deployed resources without storing plaintext values in state, plans, logs, or errors. Secret values remain strictly in process memory for the duration of the deploy that writes them.

## External sources

External credential sources read secrets from your environment or vault without managing their upstream lifecycle. Removing a credential source from TypeScript deletes only its state record, never the secret at the source.

Install `@notation/std` to use the built-in `sources.Env` and `sources.Dotenv` sources:

```sh [Terminal]
@pm.add("@notation/std")
```

Declare a source in `infra/` and wire `.credentials.value` directly into a consumer such as `$lambda`:

::code-group

```ts [infra/secrets.ts]
import { sources } from "@notation/std/resources";

export const stripeKey = new sources.Env("stripe-key", {
  config: {
    key: "STRIPE_KEY",
    track: "hmac",
  },
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

Always reference credentials via `.credentials.<name>` and pass the reference whole. Calling `outputRef()` on a credential or passing a credential into `text`, `.map()`, or `all()` throws so plaintext never enters state.

### Change tracking

Because Notation never writes secret values to state, `sources.Env` and `sources.Dotenv` use the `track` option to decide whether downstream consumers need to update:

| Option | Behavior |
| :--- | :--- |
| `undefined` | Re-deploys consumers on every run |
| `"hmac"` | Compares a keyed HMAC-SHA256 hash using `NOTATION_TRACK_KEY` |
| `"scrypt"` | Compares a slow salted hash with no extra key |

Use `"scrypt"` only for high-entropy generated secrets.

For `"hmac"`, set the same `NOTATION_TRACK_KEY` across every machine and CI runner:

```sh [Terminal]
export NOTATION_TRACK_KEY="your-shared-track-key"
```

## Minted credentials

Resources that generate credentials on creation – such as `AccountToken` in [Cloudflare Secrets](../providers/cloudflare/secrets.md) – expose them through `.credentials.<name>` just like external sources:

```ts [infra/tokens.ts]
import * as cloudflare from "@notation/cloudflare/resources";

export const store = new cloudflare.secretsStore.SecretsStore("account-store");

export const deployToken = new cloudflare.tokens.AccountToken("deploy-token", {
  config: {
    Policies: [
      {
        effect: "allow",
        permissionGroups: ["Workers Scripts Write"],
        resources: { [`com.cloudflare.api.account.${process.env.CLOUDFLARE_ACCOUNT_ID!}`]: "*" },
      },
    ],
  },
});

export const deployTokenSecret =
  new cloudflare.secretsStore.SecretsStoreSecret("deploy-token-secret", {
    config: { Value: deployToken.credentials.Value },
    dependencies: { store },
  });
```

Notation holds the minted token in memory while creating or updating consumers and writes only an opaque version marker to state. On a later deploy or resumed process, if a consumer needs the credential again:

- **Credential sources** – Reload the secret automatically under the same version.
- **Rotatable resources** – Issue a fresh value via rotation (such as `AccountToken`) and update affected consumers.
- **Non-rotatable resources** – Fail pre-flight validation with `UnobtainableCredentialError`, printing ready-to-run `--credential` and `--replace` commands (see [Recovery](./recovery.md)).

## Redaction

Notation prevents accidental secret leaks in logs and exceptions using `Redacted<T>` (`@notation/core`) and automatic error scrubbing.

Wrap sensitive runtime values in `Redacted` so logging prints `Redacted(<hidden>)` and accidental string or JSON coercion throws `RedactedValueError`:

```ts [infra/redacted.ts]
import { Redacted } from "@notation/core";

const stripeKey = new Redacted("sk_live_orders_123");

// Explicit unwrap at the boundary where the secret is sent:
const headers = { Authorization: `Bearer ${stripeKey.unwrap()}` };

console.log(stripeKey); // Redacted(<hidden>)
```

Any secret loaded or minted during a run is also scrubbed to `<hidden>` across thrown errors and validation messages.
