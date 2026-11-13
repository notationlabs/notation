import { registerSecretTarget } from "@notation/core";
import { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import * as cloudflare from "src/resources";
import type { BindableSecret, SecretTargetResource } from "src/workers/declaration";
import {
  assertSecretName,
  claimSecretIdentity,
  ensureSecretsStore,
  scopedSecretName,
} from "./store";

const SECRET_NAME_MAX_LENGTH = 255;

export type SecretConfig<Id extends string = string> = {
  /**
   * Notation's logical ID for the secret: keys it in state, and names it in
   * `notation secret set <id>`.
   */
  id: Id;
  /**
   * Replaces `<app>--<stage>--<id>` with an exact secret name in the store,
   * for adopting an existing secret or sharing one across stages.
   */
  name?: string;
} & (
  | {
      /** Where the secret's value is read from, e.g. `env`, `dotenv(...)`, or `infisical(...)`. */
      source: Source;
      /** The key requested from `source`. */
      key: string;
    }
  | { source?: never; key?: never }
);

class SecretGroup extends ResourceGroup<{ id: string; name: string }> {
  readonly value?: std.sources.SourceValueInstance;
  readonly secret: cloudflare.secretsStore.SecretsStoreSecretInstance;

  constructor(opts: {
    id: string;
    name: string;
    adopted: boolean;
    source?: Source;
    key?: string;
    store: cloudflare.secretsStore.SecretsStoreInstance;
  }) {
    super("cloudflare/secret", opts.id, { id: opts.id, name: opts.name });
    this.value =
      opts.source && opts.key !== undefined
        ? this.add(
            new std.sources.SourceValue(`value:${opts.id}`, {
              config: { Source: opts.source.name, Key: opts.key },
              source: opts.source,
            }),
          )
        : undefined;
    this.secret = this.add(
      new cloudflare.secretsStore.SecretsStoreSecret(`secret:${opts.id}`, {
        config: {
          Name: opts.name,
          ...(opts.adopted ? { Adopted: true } : {}),
        },
        dependencies: {
          store: opts.store,
          ...(this.value ? { value: this.value } : {}),
        },
      }),
    );
  }
}

/**
 * Declares a secret in the account's Cloudflare Secrets Store. Bind it to a
 * Worker with `secretsStore.bind(mySecret)`.
 * @resource
 */
export function secret<const Id extends string>(
  config: SecretConfig<Id>,
): BindableSecret {
  if (typeof config.id !== "string" || config.id.length === 0) {
    throw new Error("secret() requires a non-empty id.");
  }
  const hasSource = config.source !== undefined;
  const hasKey = config.key !== undefined;
  if (hasSource !== hasKey) {
    throw new Error(
      `secret({ id: "${config.id}" }) requires both source and key, or neither.`,
    );
  }
  if (hasKey && (typeof config.key !== "string" || config.key.length === 0)) {
    throw new Error(`secret({ id: "${config.id}" }) requires a non-empty key.`);
  }
  if (config.name !== undefined && typeof config.name !== "string") {
    throw new Error(`secret({ id: "${config.id}" }) name must be a string.`);
  }

  const adopted = config.name !== undefined;
  const secretName = config.name ?? scopedSecretName(config.id);
  assertSecretName("secret()", secretName, SECRET_NAME_MAX_LENGTH);
  claimSecretIdentity("secret", config.id, secretName);

  const store = ensureSecretsStore();
  const group = new SecretGroup({
    id: config.id,
    name: secretName,
    adopted,
    source: config.source,
    key: config.key,
    store,
  });

  registerSecretTarget({
    id: config.id,
    resource: group.secret,
    ...(config.source ? { source: config.source, key: config.key } : {}),
  });

  return {
    id: config.id,
    "~secret": () => group.secret as unknown as SecretTargetResource,
  };
}
