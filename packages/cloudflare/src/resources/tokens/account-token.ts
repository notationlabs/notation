import * as v from "valibot";
import { recordSecretValue } from "@notation/core";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { sortedJson } from "@notation/utils";
import { cloudflareCreate } from "src/api/client";
import {
  deleteSecret,
  findSecretByName,
  writeSecret,
} from "src/api/secrets-store";
import {
  createToken,
  deleteToken,
  findPermissionGroups,
  findTokensByName,
  getToken,
  updateToken,
  type Token,
  type TokenPolicyRequest,
} from "src/api/tokens";
import type { SecretsStoreInstance } from "src/resources/secrets-store";

export const TOKEN_NAME_MAX_LENGTH = 120;

const policySchema = v.strictObject({
  effect: v.picklist(["allow", "deny"]),
  /**
   * The names of the permission groups, as Cloudflare lists them, such as
   * `Workers Scripts Write`.
   */
  permissionGroups: v.pipe(
    v.array(v.pipe(v.string(), v.nonEmpty())),
    v.minLength(1),
  ),
  /**
   * The resources that the policy applies to, such as
   * `{ "com.cloudflare.api.account.<account id>": "*" }`.
   */
  resources: v.record(
    v.string(),
    v.union([v.string(), v.record(v.string(), v.string())]),
  ),
});

export type AccountTokenPolicy = v.InferOutput<typeof policySchema>;

type AccountTokenParams = {
  AccountId: string;
  StoreId: string;
  /** The token's name, and the name of the secret that holds its value. */
  Name: string;
  Policies: AccountTokenPolicy[];
};

export type AccountTokenSchema = {
  Key: { AccountId: string; TokenId: string; StoreId: string; Name: string };
  CreateParams: AccountTokenParams;
  UpdateParams: Pick<AccountTokenParams, "Policies">;
  ReadResult: { SecretId: string };
};

export type AccountTokenDependencies = {
  store: SecretsStoreInstance;
};

const accountToken = resource<AccountTokenSchema>({
  type: "cloudflare/tokens/AccountToken",
  provider: "@notation/cloudflare/resources",
});

const accountTokenSchema = accountToken.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  StoreId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(TOKEN_NAME_MAX_LENGTH),
    ),
  },
  Policies: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.array(policySchema), v.minLength(1)),
  },
  TokenId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  SecretId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * An account-owned API token, whose value is kept in a secret of the
 * account's Secrets Store. The secret has the token's name. Its record holds
 * where the secret is, and never the value.
 *
 * Create writes the new token's value into the secret in the same step,
 * because Cloudflare returns the value only in the create's response. A
 * create with an unknown outcome deletes the tokens with the name, and runs
 * again. A
 * change to the policies updates the token in place, and the token keeps
 * its value. Delete deletes the token and its secret.
 *
 * Read fails when the secret is missing, as the value can't be fetched
 * again. The token has to be rotated.
 */
export const AccountToken = accountTokenSchema
  .defineOperations({
    create: async (params) => {
      const policies = await policyRequests(params.AccountId, params.Policies);
      const token = await cloudflareCreate(createToken)(params.AccountId, {
        name: params.Name,
        policies,
      });
      recordSecretValue(token.value);
      try {
        await writeSecret(
          params.AccountId,
          params.StoreId,
          params.Name,
          token.value,
        );
      } catch (error) {
        // The value is lost when the write fails, so the token is deleted,
        // and the next deploy creates a new one.
        try {
          await deleteToken(params.AccountId, token.id);
        } catch {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}. The API token ${token.id} that was just created couldn't be deleted. Delete it in the dashboard.`,
            { cause: error },
          );
        }
        throw error;
      }
      return { TokenId: token.id };
    },

    // Runs when a create may have made a token and its outcome is unknown.
    // A token made then can't be used, as its value is lost, so every token
    // with the name is deleted and the create runs again. Replace deletes
    // the old token before it creates the new one, so no tracked token has
    // the name.
    find: async (params) => {
      const ids = await findTokensByName(params.AccountId, params.Name);
      await Promise.all(ids.map((id) => deleteToken(params.AccountId, id)));
      throw new ResourceNotFoundError(
        "A token made by an earlier create has no value",
      );
    },

    read: async (key) => {
      const token = await getToken(key.AccountId, key.TokenId);
      if (!token) {
        throw new ResourceNotFoundError("API token was not found");
      }
      const secret = await findSecretByName(
        key.AccountId,
        key.StoreId,
        key.Name,
      );
      if (!secret) {
        throw new Error(
          `The secret ${key.Name}, which holds the value of the API token ${key.TokenId}, isn't in the Secrets Store ${key.StoreId}. Cloudflare returns a token's value only when it creates the token, so the secret can't be written again. Rotate the token: change the id of its accountToken() declaration, and deploy.`,
        );
      }
      const policies = readPolicies(token);
      return {
        ...key,
        SecretId: secret.id,
        ...(policies ? { Policies: policies } : {}),
      };
    },

    update: async (key, _patch, params) => {
      await updateToken(key.AccountId, key.TokenId, {
        name: params.Name,
        policies: await policyRequests(params.AccountId, params.Policies),
      });
    },

    delete: async (key) => {
      await deleteToken(key.AccountId, key.TokenId);
      await deleteSecret(key.AccountId, key.StoreId, key.Name);
    },
  })
  .requireDependencies<AccountTokenDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.store.output.AccountId,
    StoreId: deps.store.output.StoreId,
  }));

export type AccountTokenInstance = InstanceType<typeof AccountToken>;

/** The policies of a request, with each permission group by ID. */
async function policyRequests(
  account: string,
  policies: AccountTokenPolicy[],
): Promise<TokenPolicyRequest[]> {
  const names = [...new Set(policies.flatMap((p) => p.permissionGroups))];
  const ids = new Map<string, string[]>();
  await Promise.all(
    names.map(async (name) => {
      const groups = await findPermissionGroups(account, name);
      if (groups.length === 0) {
        throw new Error(
          `Cloudflare has no API token permission group named "${name}". Use the name that the dashboard shows when you create a token, such as "Workers Scripts Write".`,
        );
      }
      ids.set(
        name,
        groups.map((group) => group.id),
      );
    }),
  );
  return policies.map((policy) => ({
    effect: policy.effect,
    permission_groups: policy.permissionGroups.flatMap((name) =>
      ids.get(name)!.map((id) => ({ id })),
    ),
    resources: policy.resources,
  }));
}

/**
 * The token's policies in the form of the params, or `undefined` when a
 * permission group has no name, as the policies then can't be compared.
 */
function readPolicies(token: Token): AccountTokenPolicy[] | undefined {
  if (!token.policies) return undefined;
  const policies: AccountTokenPolicy[] = [];
  for (const policy of token.policies) {
    const names = policy.permission_groups.map((group) => group.name);
    if (names.some((name) => name === undefined)) return undefined;
    policies.push({
      effect: policy.effect,
      permissionGroups: names as string[],
      resources: policy.resources,
    });
  }
  return sortedPolicies(policies);
}

/**
 * Sorts the policies, and the permission groups in each one, so that the
 * order that Cloudflare returns them in is not seen as a change. The order
 * has no effect on what the token can do.
 */
export function sortedPolicies(
  policies: AccountTokenPolicy[],
): AccountTokenPolicy[] {
  return policies
    .map((policy) => ({
      ...policy,
      permissionGroups: [...new Set(policy.permissionGroups)].sort(),
    }))
    .sort((a, b) => compare(sortedJson.encode(a), sortedJson.encode(b)));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
