import {
  declareSecret,
  isProducedSource,
  PRODUCED_SOURCE,
  type ProducedSource,
} from "@notation/core";
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
import { SECRETS_STORE_PROVIDER } from "src/resources/secrets-store/secrets-store-secret";
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
  | {
      /**
       * A value that a resource gets when it is created, such as
       * `app.sources.privateKey`. That resource's create writes the value,
       * and this secret is created after it. Deploy never asks for the
       * value, and `notation secret set` and `notation secret delete`
       * refuse the secret.
       */
      source: ProducedSource;
      key?: never;
    }
  | { source?: undefined; key?: undefined }
);

/**
 * Set by a declaration that makes its secret with `SecretGroup`, such as
 * `accountToken()`.
 */
export type SecretGroupOptions = {
  /**
   * The name in the store, in place of `<app>--<stage>--<id>`. Unlike
   * `config.name`, the secret stays stage-scoped, so destroy deletes it.
   */
  scopedName?: string;
  /** Names the declaration in errors, such as `accountToken({ id: "ci" })`. */
  declaration?: string;
};

export class SecretGroup
  extends ResourceGroup<SecretConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly secret: cloudflare.secretsStore.SecretsStoreSecretInstance;
  /** Records the source and key of a secret that has a source. */
  readonly value?: std.sources.SourceValueInstance;

  constructor(config: SecretConfig, options: SecretGroupOptions = {}) {
    assertSecretId("secret()", config.id);
    const name =
      config.name ??
      options.scopedName ??
      scopedPhysicalName(config.id, {
        maxLength: SECRET_NAME_MAX_LENGTH,
      });
    const declaration = options.declaration ?? describe(config);
    claimSecretName(name, declaration);
    super("cloudflare/secret", config.id, config);
    const { id } = config;
    const store = secretsStoreGroup().store;
    const produced = isProducedSource(config.source)
      ? config.source["~producedSource"]
      : undefined;
    const source = produced ? undefined : (config.source as Source | undefined);
    let valueFrom: SecretValueFrom;
    if (produced) {
      // The target holds only outputs of resources that the producer
      // depends on, so the producer's create can resolve it.
      produced.register({
        provider: SECRETS_STORE_PROVIDER,
        params: {
          AccountId: store.outputRef("AccountId"),
          StoreId: store.outputRef("StoreId"),
          Name: name,
        },
      });
      valueFrom = {
        Secret: id,
        Source: PRODUCED_SOURCE,
        Producer: produced.resource.id,
        Rotation: produced.rotation,
      };
    } else {
      const added = addSecretValue(this, declaration, {
        id,
        source,
        key: config.key,
      });
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
        dependencies: { store },
      }),
    );
    if (produced) this.secret.dependOn(produced.resource);

    const explicitName =
      config.name === undefined
        ? undefined
        : `\`${id}\` has the explicit name ${config.name}, so notation didn't create it and doesn't delete it. Delete it with wrangler or in the Cloudflare dashboard.`;
    declareSecret({
      id,
      source,
      key: source ? config.key : undefined,
      set: produced
        ? undefined
        : async (value) => {
            const account = accountId();
            const [store] = await listStores(account);
            const storeId =
              store?.id ?? (await createStore(account, DEFAULT_STORE_NAME)).id;
            await writeSecret(account, storeId, name, value);
          },
      delete:
        produced || explicitName
          ? undefined
          : async () => {
              const account = accountId();
              const [store] = await listStores(account);
              if (store) await deleteSecret(account, store.id, name);
            },
      refusal: produced
        ? `Only the create of ${produced.producer} writes the value of \`${id}\`, so \`notation secret\` can't set or delete it. ${produced.rotation}`
        : explicitName,
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
 * or asks for it when there is no source. When `source` is a produced
 * source, such as `app.sources.privateKey`, the create of the resource that
 * produces it writes the value. A replacement of that resource writes a new
 * value to the same secret. Notation records where the secret is and where
 * its value comes from, and never the value.
 * @resource
 */
export function secret(config: SecretConfig): SecretGroup {
  return new SecretGroup(config);
}
