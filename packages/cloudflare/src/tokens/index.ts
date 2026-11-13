import { declareSecret } from "@notation/core";
import { ResourceGroup, scopedPhysicalName } from "@notation/resource";
import * as cloudflare from "src/resources";
import { TOKEN_NAME_MAX_LENGTH } from "src/resources/tokens/account-token";
import {
  assertSecretId,
  claimSecretName,
  secretsStoreGroup,
} from "src/secrets-store/store";
import type { BindableSecret } from "src/workers/declaration";

export type { AccountTokenPolicy } from "src/resources/tokens/account-token";
export type { BindableSecret } from "src/workers/declaration";

export type AccountTokenConfig = {
  /**
   * Keys the token in state. The token, and the secret that holds its value,
   * are named `<app>--<stage>--<id>`. Changing the id rotates the token: a
   * new token replaces it.
   */
  id: string;
  /** What the token can do. A change updates the token, which keeps its value. */
  policies: cloudflare.tokens.AccountTokenPolicy[];
};

export class AccountTokenGroup
  extends ResourceGroup<AccountTokenConfig>
  implements BindableSecret
{
  platform = "cloudflare";
  readonly token: cloudflare.tokens.AccountTokenInstance;

  constructor(config: AccountTokenConfig) {
    assertSecretId("accountToken()", config.id);
    const name = scopedPhysicalName(config.id, {
      maxLength: TOKEN_NAME_MAX_LENGTH,
    });
    claimSecretName(name, `accountToken({ id: "${config.id}" })`);
    super("cloudflare/accountToken", config.id, config);
    this.token = this.add(
      new cloudflare.tokens.AccountToken(`token:${config.id}`, {
        config: { Name: name, Policies: config.policies },
        dependencies: { store: secretsStoreGroup().store },
      }),
    );
    declareSecret({
      id: config.id,
      refusal: `\`${config.id}\` is the secret of an API token, and only the token's create writes its value. To get a new value, rotate the token: change the id of its accountToken() declaration, and deploy.`,
    });
  }

  "~secret"() {
    return this.token;
  }
}

/**
 * Declares an account-owned API token. Its value is written to a secret in
 * the account's Secrets Store when the token is created, and a Worker binds
 * it with `secretsStore.bind(token)`. Notation never records the value.
 * `CLOUDFLARE_API_TOKEN` needs the Account API Tokens: Edit permission.
 * @resource
 */
export function accountToken(config: AccountTokenConfig): AccountTokenGroup {
  return new AccountTokenGroup(config);
}
