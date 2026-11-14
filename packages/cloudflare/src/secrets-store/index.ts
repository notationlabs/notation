import { declareSecret, ONE_TIME_SOURCE } from "@notation/core";
import { ResourceGroup, scopedPhysicalName } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import { accountId } from "src/api/client";
import {
  createStore,
  DEFAULT_STORE_NAME,
  deleteSecret,
  listStores,
  writeSecret,
} from "src/api/secrets-store";
import * as cloudflare from "src/resources";
import type { BindableSecret } from "src/workers/declaration";
import {
  addSecretValue,
  assertSecretId,
  type SecretValueFrom,
} from "src/secrets/value";
import {
  claimSecretName,
  SECRET_NAME_MAX_LENGTH,
  secretsStoreGroup,
} from "./store";

export { SecretsStoreGroup } from "./store";
export type { BindableSecret } from "src/workers/declaration";

export type SecretConfig = {
  /**
   * Keys the secret in state, and is what `notation secret set <id>` takes.
   * The secret's name in the store is `<app>--<stage>--<id>`. Changing the
   * id replaces the secret.
   */
  id: string;
  /**
   * An exact name in the store, in place of `<app>--<stage>--<id>`. It isn't
   * scoped to the stage, so use it to adopt a secret that exists, or to
   * share one between stages. Destroy leaves a secret with an explicit name.
   */
  name?: string;
} & (
  | {
      /**
       * Where the value comes from, such as `env` or `dotenv(".env.local")`
       * from `@notation/std/sources`. Without a source, deploy asks for the
       * value when it creates the secret, and `notation secret set` sets it.
       */
      source: Source;
      /** The key that the source is asked for. */
      key: string;
    }
  | { source?: undefined; key?: undefined }
);

/**
 * Set by a declaration that makes its secret with `SecretGroup`, such as
 * `accountToken()`.
 */
export type SecretGroupOptions = {
  /** Names the declaration in errors, such as `accountToken({ id: "ci" })`. */
  declaration?: string;
  /**
   * Set when the create of another resource writes the value, as the
   * token's create does for `accountToken()`. The caller makes the secret
   * depend on that resource. The secret's create then only checks that the
   * secret exists, and `notation secret set` and `notation secret delete`
   * refuse the secret with `refusal`.
   */
  oneTime?: { refusal: string };
};

export class SecretGroup
  extends ResourceGroup<SecretConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly secret: cloudflare.secretsStore.SecretsStoreSecretInstance;
  /** Records the source and key of a secret that has a source. */
  readonly value?: std.sources.SourceValueInstance;
  /** The secret's name in the store. */
  readonly name: string;

  constructor(config: SecretConfig, options: SecretGroupOptions = {}) {
    assertSecretId("secret()", config.id);
    const name =
      config.name ??
      scopedPhysicalName(config.id, {
        maxLength: SECRET_NAME_MAX_LENGTH,
      });
    const declaration = options.declaration ?? describe(config);
    claimSecretName(name, declaration);
    super("cloudflare/secret", config.id, config);
    this.name = name;
    const { id, source, key } = config;
    const { oneTime } = options;
    let valueFrom: SecretValueFrom;
    if (oneTime) {
      valueFrom = { Secret: id, Source: ONE_TIME_SOURCE };
    } else {
      const added = addSecretValue(this, declaration, { id, source, key });
      this.value = added.value;
      valueFrom = added.valueFrom;
    }
    this.secret = this.add(
      new cloudflare.secretsStore.SecretsStoreSecret(`secret:${id}`, {
        config: {
          Name: name,
          StageScoped: config.name === undefined,
          ValueFrom: valueFrom,
        },
        dependencies: { store: secretsStoreGroup().store },
      }),
    );

    const explicitName =
      config.name === undefined
        ? undefined
        : `\`${id}\` has the explicit name ${config.name}, so notation didn't create it and doesn't delete it. Delete it with wrangler or in the Cloudflare dashboard.`;
    declareSecret({
      id,
      source,
      key,
      set: oneTime
        ? undefined
        : async (value) => {
            const account = accountId();
            const [store] = await listStores(account);
            const storeId =
              store?.id ?? (await createStore(account, DEFAULT_STORE_NAME)).id;
            await writeSecret(account, storeId, name, value);
          },
      delete:
        oneTime || explicitName
          ? undefined
          : async () => {
              const account = accountId();
              const [store] = await listStores(account);
              if (store) await deleteSecret(account, store.id, name);
            },
      refusal: oneTime?.refusal ?? explicitName,
    });
  }

  "~secret"() {
    return this.secret;
  }
}

const describe = (config: SecretConfig) =>
  config.name === undefined
    ? `secret({ id: "${config.id}" })`
    : `secret({ id: "${config.id}", name: "${config.name}" })`;

/**
 * Declares a secret in the account's Secrets Store, which a Worker binds
 * with `secretsStore.bind(secret)`. Deploy writes the value from `source`,
 * or asks for it when there is no source. Notation records where the secret
 * is and where its value comes from, and never the value.
 * @resource
 */
export function secret(config: SecretConfig): SecretGroup {
  return new SecretGroup(config);
}
