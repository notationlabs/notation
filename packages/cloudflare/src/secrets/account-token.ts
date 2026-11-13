import { registerSecretTarget } from "@notation/core";
import { ResourceGroup } from "@notation/resource";
import * as cloudflare from "src/resources";
import type { TokenCondition, TokenPolicy } from "src/api/tokens";
import type { BindableSecret, SecretTargetResource } from "src/workers/declaration";
import {
  assertSecretName,
  claimSecretIdentity,
  ensureSecretsStore,
  scopedSecretName,
} from "./store";

const TOKEN_NAME_MAX_LENGTH = 120;

export type AccountTokenPolicy = {
  effect: "allow" | "deny";
  /**
   * Permission group names (such as `"Workers Scripts Write"`) or IDs
   * (`{ id: "..." }`).
   */
  permissionGroups: readonly (string | { id: string })[];
  resources: TokenPolicy["resources"];
};

export type AccountTokenConfig<Id extends string = string> = {
  /**
   * Logical ID for the token. Keys it in state and forms the token and secret
   * name `<app>--<stage>--<id>`. Changing `id` rotates the token.
   */
  id: Id;
  policies: readonly AccountTokenPolicy[];
  condition?: TokenCondition;
  expiresOn?: string;
  notBefore?: string;
};

class AccountTokenGroup extends ResourceGroup<{ id: string; name: string }> {
  readonly token: cloudflare.tokens.AccountTokenInstance;

  constructor(opts: {
    id: string;
    name: string;
    config: AccountTokenConfig;
    store: cloudflare.secretsStore.SecretsStoreInstance;
  }) {
    super("cloudflare/accountToken", opts.id, { id: opts.id, name: opts.name });
    this.token = this.add(
      new cloudflare.tokens.AccountToken(`token:${opts.id}`, {
        config: {
          Name: opts.name,
          Policies: opts.config.policies.map((policy) => ({
            effect: policy.effect,
            permission_groups: policy.permissionGroups.map((group) =>
              typeof group === "string" ? group : { id: group.id },
            ),
            resources: policy.resources,
          })),
          ...(opts.config.condition !== undefined
            ? { Condition: opts.config.condition }
            : {}),
          ...(opts.config.expiresOn !== undefined
            ? { ExpiresOn: opts.config.expiresOn }
            : {}),
          ...(opts.config.notBefore !== undefined
            ? { NotBefore: opts.config.notBefore }
            : {}),
        },
        dependencies: { store: opts.store },
      }),
    );
  }
}

/**
 * Declares an account-owned Cloudflare API token whose one-time value is
 * written directly into the account's Secrets Store. Bind it to a Worker with
 * `secretsStore.bind(token)`.
 * @resource
 */
export function accountToken<const Id extends string>(
  config: AccountTokenConfig<Id>,
): BindableSecret {
  if (typeof config.id !== "string" || config.id.length === 0) {
    throw new Error("accountToken() requires a non-empty id.");
  }
  if (!Array.isArray(config.policies) || config.policies.length === 0) {
    throw new Error(
      `accountToken({ id: "${config.id}" }) requires at least one policy.`,
    );
  }

  const tokenName = scopedSecretName(config.id);
  assertSecretName("accountToken()", tokenName, TOKEN_NAME_MAX_LENGTH);
  claimSecretIdentity("accountToken", config.id, tokenName);

  const store = ensureSecretsStore();
  const group = new AccountTokenGroup({
    id: config.id,
    name: tokenName,
    config,
    store,
  });

  registerSecretTarget({
    id: config.id,
    resource: group.token,
    isToken: true,
  });

  return {
    id: config.id,
    "~secret": () => group.token as unknown as SecretTargetResource,
  };
}
