import { producedSource, type ProducedSource } from "@notation/core";
import { ResourceGroup, scopedPhysicalName } from "@notation/resource";
import * as cloudflare from "src/resources";
import { TOKEN_NAME_MAX_LENGTH } from "src/resources/tokens/account-token";
import { SecretGroup } from "src/secrets-store";
import { secretsStoreGroup } from "src/secrets-store/store";
import { assertSecretId } from "src/secrets/value";
import type { BindableSecret } from "src/workers/declaration";

export type {
  AccountTokenCondition,
  AccountTokenPolicy,
} from "src/resources/tokens/account-token";
export type { BindableSecret } from "src/workers/declaration";

export type AccountTokenConfig = {
  /**
   * Keys the token in state. The token, and the secret that holds its value,
   * are named `<app>--<stage>--<id>`. Changing the id replaces both with a
   * new token and a new secret under the new name. To rotate the token and
   * keep its secret, delete the token in the Cloudflare dashboard, then run
   * `notation deploy`.
   */
  id: string;
  /** What the token can do. A change updates the token, which keeps its value. */
  policies: cloudflare.tokens.AccountTokenPolicy[];
  /**
   * The client IP ranges, in CIDR notation, that may or may not use the
   * token. A change updates the token, which keeps its value.
   */
  condition?: cloudflare.tokens.AccountTokenCondition;
};

export class AccountTokenGroup
  extends ResourceGroup<AccountTokenConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly token: cloudflare.tokens.AccountTokenInstance;
  /** The token's value, which another secret can also take as its source. */
  readonly sources: { value: ProducedSource };
  /** The secret that holds the token's value, with the id of the token. */
  readonly secret: SecretGroup;

  constructor(config: AccountTokenConfig) {
    assertSecretId("accountToken()", config.id);
    const declaration = `accountToken({ id: "${config.id}" })`;
    const name = scopedPhysicalName(config.id, {
      maxLength: TOKEN_NAME_MAX_LENGTH,
    });
    super("cloudflare/accountToken", config.id, config);
    this.token = this.add(
      new cloudflare.tokens.AccountToken(`token:${config.id}`, {
        config: {
          Name: name,
          Policies: config.policies,
          Condition: config.condition,
        },
        dependencies: { store: secretsStoreGroup().store },
      }),
    );
    this.sources = {
      value: producedSource({
        producer: declaration,
        resource: this.token,
        name: "value",
        param: "ValueTargets",
        rotation: `To rotate ${declaration}, delete the API token ${name} in the Cloudflare dashboard, then run \`notation deploy\`. Deploy creates a new token and writes its value to each secret that takes it.`,
      }),
    };
    // The secret has the token's name, which is the name that the token's
    // value was written to before the token wrote through `sources.value`.
    this.secret = new SecretGroup(
      { id: config.id, source: this.sources.value },
      { scopedName: name, declaration },
    );
  }

  "~secret"() {
    return this.secret["~secret"]();
  }
}

/**
 * Declares an account-owned API token. Its value is written to a secret in
 * the account's Secrets Store when the token is created, and a Worker binds
 * it with `secretsStore.bind(token)`. The secret has the id of the token, and
 * `notation secret set` and `notation secret delete` refuse it. Notation
 * never records the value.
 * `CLOUDFLARE_API_TOKEN` needs the Account API Tokens: Edit permission.
 * @resource
 */
export function accountToken(config: AccountTokenConfig): AccountTokenGroup {
  return new AccountTokenGroup(config);
}
