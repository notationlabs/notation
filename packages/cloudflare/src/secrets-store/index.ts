import { ResourceGroup, scopedPhysicalName } from "@notation/resource";
import * as cloudflare from "src/resources";
import type { BindableSecret } from "src/workers/declaration";
import { assertSecretId, claimSecretName, secretsStoreGroup } from "./store";

export { SecretsStoreGroup } from "./store";
export type { BindableSecret } from "src/workers/declaration";

export type SecretConfig = {
  /**
   * Keys the secret in state. The secret's name in the store is
   * `<app>--<stage>--<id>`. Changing the id replaces the secret.
   */
  id: string;
  /**
   * An exact name in the store, in place of `<app>--<stage>--<id>`. It isn't
   * scoped to the stage, so use it to adopt a secret that exists, or to
   * share one between stages. Destroy leaves a secret with an explicit name.
   */
  name?: string;
};

export class SecretGroup
  extends ResourceGroup<SecretConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly secret: cloudflare.secretsStore.SecretsStoreSecretInstance;

  constructor(config: SecretConfig) {
    assertSecretId("secret()", config.id);
    const name = config.name ?? scopedPhysicalName(config.id, secretNameRule);
    claimSecretName(name, describe(config));
    super("cloudflare/secret", config.id, config);
    this.secret = this.add(
      new cloudflare.secretsStore.SecretsStoreSecret(`secret:${config.id}`, {
        config: { Name: name, StageScoped: config.name === undefined },
        dependencies: { store: secretsStoreGroup().store },
      }),
    );
  }

  "~secret"() {
    return this.secret;
  }
}

const secretNameRule = { maxLength: 255 };

const describe = (config: SecretConfig) =>
  config.name === undefined
    ? `secret({ id: "${config.id}" })`
    : `secret({ id: "${config.id}", name: "${config.name}" })`;

/**
 * Declares a secret in the account's Secrets Store, which a Worker binds
 * with `secretsStore.bind(secret)`. Notation records where the secret is,
 * and never its value. The secret must exist before the first deploy: set it
 * with wrangler or in the Cloudflare dashboard.
 * @resource
 */
export function secret(config: SecretConfig): SecretGroup {
  return new SecretGroup(config);
}
