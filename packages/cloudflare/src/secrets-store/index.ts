import { declareSecret } from "@notation/core";
import { ResourceGroup, scopedPhysicalName } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import * as cloudflare from "src/resources";
import { PROMPT_SOURCE } from "src/resources/secrets-store";
import type { BindableSecret } from "src/workers/declaration";
import { assertSecretId, claimSecretName, secretsStoreGroup } from "./store";

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

export class SecretGroup
  extends ResourceGroup<SecretConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly secret: cloudflare.secretsStore.SecretsStoreSecretInstance;
  /** Records the source and key of a secret that has a source. */
  readonly value?: std.sources.SourceValueInstance;

  constructor(config: SecretConfig) {
    assertSecretId("secret()", config.id);
    assertSourceAndKey(config);
    const name = config.name ?? scopedPhysicalName(config.id, secretNameRule);
    claimSecretName(name, describe(config));
    super("cloudflare/secret", config.id, config);
    const { id, source, key } = config;
    if (source) {
      this.value = this.add(
        new std.sources.SourceValue(`value:${id}`, {
          config: { Source: source.name, Key: key! },
          source,
          secret: id,
        }),
      );
    }
    this.secret = this.add(
      new cloudflare.secretsStore.SecretsStoreSecret(`secret:${id}`, {
        config: {
          Name: name,
          StageScoped: config.name === undefined,
          ValueFrom: this.value
            ? {
                Secret: id,
                Source: source!.name,
                Key: key!,
                Version: this.value.outputRef("Version"),
              }
            : { Secret: id, Source: PROMPT_SOURCE },
        },
        dependencies: { store: secretsStoreGroup().store },
      }),
    );
    declareSecret({
      id,
      resource: this.secret,
      source,
      key,
      ...(config.name === undefined
        ? {}
        : {
            refuseDelete: `\`${id}\` has the explicit name ${config.name}, so notation didn't create it and doesn't delete it. Delete it with wrangler or in the Cloudflare dashboard.`,
          }),
    });
  }

  "~secret"() {
    return this.secret;
  }
}

const secretNameRule = { maxLength: 255 };

function assertSourceAndKey(config: SecretConfig): void {
  const hasSource = config.source !== undefined;
  const hasKey = config.key !== undefined;
  if (hasSource !== hasKey) {
    throw new Error(
      `${describe(config)} has a ${hasSource ? "source but no key" : "key but no source"}. Give source and key together, or leave both out.`,
    );
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
