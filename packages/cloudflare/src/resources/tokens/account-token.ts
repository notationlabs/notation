import * as v from "valibot";
import { recordSecret, scrubError } from "@notation/core";
import {
  containsOutputRef,
  planLookup,
  resolveOutputRefs,
  resource,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  type BaseResource,
} from "@notation/resource";
import {
  accountId,
  cloudflareCreate,
  rejectAccountReplace,
} from "src/api/client";
import { findSecretByName, isStoreNotFound } from "src/api/secrets-store";
import {
  createToken,
  deleteToken,
  getToken,
  listPermissionGroups,
  tokenConditionSchema,
  tokenPolicyInputSchema,
  updateToken,
  type PermissionGroup,
  type Token,
  type TokenCondition,
  type TokenPolicy,
  type TokenPolicyInput,
} from "src/api/tokens";
import type { SecretsStoreInstance } from "src/resources/secrets-store";
import {
  deleteSecretByName,
  upsertSecretByName,
} from "src/resources/secrets-store/secret-ops";

export type { TokenCondition, TokenPolicy, TokenPolicyInput };

type AccountTokenParams = {
  AccountId: string;
  StoreId: string;
  Name: string;
  Policies: TokenPolicyInput[];
  Condition?: TokenCondition;
  ExpiresOn?: string;
  NotBefore?: string;
};

export type AccountTokenSchema = {
  Key: {
    AccountId: string;
    StoreId: string;
    Name: string;
    TokenId: string;
  };
  CreateParams: AccountTokenParams;
  UpdateParams: Omit<AccountTokenParams, "AccountId" | "StoreId" | "Name">;
  ReadResult: { SecretId: string };
};

export type AccountTokenDependencies = {
  store: SecretsStoreInstance;
};

const accountToken = resource<AccountTokenSchema>({
  type: "cloudflare/tokens/AccountToken",
  provider: "@notation/cloudflare/resources",
});

// An ISO 8601 time in UTC, with or without milliseconds. `deriveParams`
// and the read both drop the milliseconds, so that the two compare equal.
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const timestampSchema = v.pipe(
  v.string(),
  v.regex(
    timestampPattern,
    "Use an ISO 8601 time in UTC, such as 2027-01-01T00:00:00Z",
  ),
  v.check(
    (time) =>
      !timestampPattern.test(time) ||
      (!Number.isNaN(Date.parse(time)) &&
        toSeconds(time) === `${time.slice(0, 19)}Z`),
    "Use a date and time that exist, such as 2027-02-28T00:00:00Z",
  ),
);

const accountTokenSchema = accountToken.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    rejectReplace: rejectAccountReplace(
      (previous) =>
        `this API token was created in the account ${previous}. An API token can't move to another account, and its Secrets Store belongs to the account ${previous}.`,
    ),
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
      v.maxLength(120),
      v.check(
        (name) => !name.includes("."),
        "Account token secret name cannot contain '.'",
      ),
    ),
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
  Policies: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.array(tokenPolicyInputSchema), v.minLength(1)),
  },
  Condition: {
    propertyType: "param",
    presence: "optional",
    value: tokenConditionSchema,
  },
  /**
   * The time from which Cloudflare rejects the token. Use a fixed time. A
   * time computed at deploy, such as a year from now, changes on every
   * deploy, so every deploy updates the token.
   */
  ExpiresOn: {
    propertyType: "param",
    presence: "optional",
    value: timestampSchema,
  },
  /** The time before which Cloudflare rejects the token. */
  NotBefore: {
    propertyType: "param",
    presence: "optional",
    value: timestampSchema,
  },
} as const);

/**
 * An account-owned Cloudflare API token whose one-time value is written
 * directly into the account's Secrets Store on creation and never stored in
 * state, params, or outputs.
 */
export const AccountToken = accountTokenSchema
  .defineOperations({
    create: async (params) => {
      const policies = await resolvePolicies(params.AccountId, params.Policies);
      let result: { id: string; value: string };
      try {
        result = await cloudflareCreate(createToken)(params.AccountId, {
          name: params.Name,
          policies,
          condition:
            params.Condition && Object.keys(params.Condition).length > 0
              ? params.Condition
              : undefined,
          expires_on: params.ExpiresOn,
          not_before: params.NotBefore,
        });
      } catch (error) {
        if (!ResourceCreationUnknownError.is(error)) throw error;
        throw new ResourceCreationUnknownError(
          `${error.message}. If the account ${params.AccountId} has an API token named ${params.Name} that the deploy doesn't track, delete it in the dashboard. Cloudflare shows a token's value only when it creates the token, so the deploy can't use that token.`,
          { cause: error },
        );
      }

      // Immediately register the one-time token value for scrubbing before
      // writing it to Secrets Store so any downstream API error is scrubbed.
      recordSecret(result.value);

      try {
        await upsertSecretByName({
          account: params.AccountId,
          storeId: params.StoreId,
          name: params.Name,
          value: result.value,
          scopesOnPatch: ["workers"],
        });
      } catch (error) {
        // Avoid leaving an orphaned token whose one-time value would be lost.
        await deleteToken(params.AccountId, result.id).catch(() => {});
        throw scrubError(error);
      }

      return { TokenId: result.id };
    },

    update: async (key, _patch, params) => {
      const policies = await resolvePolicies(key.AccountId, params.Policies);
      await updateToken(key.AccountId, key.TokenId, {
        name: key.Name,
        policies,
        condition: params.Condition ?? {},
        expires_on: params.ExpiresOn ?? null,
        not_before: params.NotBefore ?? null,
      });
    },

    read: async function (this: BaseResource, key) {
      const token = await getToken(key.AccountId, key.TokenId);
      if (!token) {
        throw new ResourceNotFoundError("API token was not found");
      }
      let secret;
      try {
        secret = await findSecretByName(key.AccountId, key.StoreId, key.Name);
      } catch (error) {
        if (!isStoreNotFound(error)) {
          throw error;
        }
      }
      if (!secret) {
        const tokenLabel = this?.id ?? key.TokenId;
        throw new Error(
          `The secret "${key.Name}" for API token "${tokenLabel}" is missing from Secrets Store "${key.StoreId}". Because Cloudflare only returns a token's value once when it is created, the secret can't be refilled. Rotate the token by changing its id.`,
        );
      }
      return {
        ...key,
        ...readParams(token),
        SecretId: secret.id,
      };
    },

    delete: async (key, state) => {
      await deleteToken(key.AccountId, key.TokenId);
      await deleteSecretByName({
        account: key.AccountId,
        storeId: key.StoreId,
        name: key.Name,
        secretId: state?.SecretId,
      });
    },
  })
  .requireDependencies<AccountTokenDependencies>()
  .deriveParams(async ({ config, deps }) => {
    const account = accountId();
    const resolve = <T>(value: T) =>
      resolveOutputRefs(value, planLookup) as T;
    const policies = resolve(config.Policies);
    const condition = resolve(config.Condition);
    const derived: Partial<AccountTokenParams> = {};
    if (policies && !containsOutputRef(policies)) {
      derived.Policies = sortedPolicies(
        await resolvePolicies(account, policies),
      );
    }
    if (!containsOutputRef(condition)) {
      derived.Condition = sortedCondition(condition) ?? {};
    }
    for (const field of ["ExpiresOn", "NotBefore"] as const) {
      const time = resolve(config[field]);
      if (time && !containsOutputRef(time)) derived[field] = toSeconds(time);
    }
    return {
      AccountId: account,
      StoreId: deps.store.output.StoreId,
      ...derived,
    } as { AccountId: string; StoreId: string };
  });

export type AccountTokenInstance = InstanceType<typeof AccountToken>;

function readParams(token: Token): Partial<AccountTokenParams> {
  const params: Partial<AccountTokenParams> = { Name: token.name };
  if (token.policies) {
    params.Policies = sortedPolicies(
      token.policies.map((policy) => ({
        effect: policy.effect,
        permission_groups: policy.permission_groups.map(({ id }) => ({ id })),
        resources: policy.resources,
      })),
    );
  }
  params.Condition = sortedCondition(token.condition) ?? {};
  if (token.expires_on) params.ExpiresOn = toSeconds(token.expires_on);
  if (token.not_before) params.NotBefore = toSeconds(token.not_before);
  return params;
}

async function resolvePolicies(
  account: string,
  policies: TokenPolicyInput[],
): Promise<TokenPolicy[]> {
  const needsLookup = policies.some((policy) =>
    policy.permission_groups.some((group) => typeof group === "string"),
  );
  const available = needsLookup ? await listPermissionGroups(account) : [];
  return policies.map((policy) => ({
    effect: policy.effect,
    permission_groups: policy.permission_groups.map((group) =>
      typeof group === "string"
        ? resolvePermissionGroup(group, policy.resources, available)
        : { id: group.id },
    ),
    resources: policy.resources,
  }));
}

function resolvePermissionGroup(
  nameOrId: string,
  resources: TokenPolicy["resources"],
  available: PermissionGroup[],
): { id: string } {
  const byId = available.find((group) => group.id === nameOrId);
  if (byId) return { id: byId.id };

  const matches = available.filter((group) => group.name === nameOrId);
  if (matches.length === 0) {
    throw new Error(
      `Unknown Cloudflare permission group "${nameOrId}". Check the permission group name in the Cloudflare dashboard or API.`,
    );
  }
  if (matches.length === 1) {
    return { id: matches[0]!.id };
  }

  // Some permission group names (e.g. "Logs Write") exist at multiple scopes.
  // Disambiguate using the policy's resource target prefixes.
  const targetScopes = resourceScopesFor(resources);
  const scoped = matches.filter((group) =>
    group.scopes?.some((scope) => targetScopes.has(scope)),
  );
  if (scoped.length === 1) {
    return { id: scoped[0]!.id };
  }
  throw new Error(
    `Cloudflare permission group "${nameOrId}" is ambiguous (${matches.map((m) => `${m.id} [${(m.scopes ?? []).join(", ")}]`).join("; ")}). Pass { id: "..." } instead.`,
  );
}

function resourceScopesFor(resources: TokenPolicy["resources"]): Set<string> {
  const scopes = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith("com.cloudflare.api.account.zone")) {
        scopes.add("com.cloudflare.api.account.zone");
      } else if (key.startsWith("com.cloudflare.api.account")) {
        scopes.add("com.cloudflare.api.account");
      } else if (key.startsWith("com.cloudflare.api.user")) {
        scopes.add("com.cloudflare.api.user");
      }
      visit(nested);
    }
  };
  visit(resources);
  return scopes;
}

/**
 * Sorts the policies, and the permission groups in each one, so that the
 * order that Cloudflare returns them in is not seen as a change.
 */
export function sortedPolicies(policies: TokenPolicy[]): TokenPolicy[] {
  return policies
    .map((policy) => ({
      ...policy,
      permission_groups: [...policy.permission_groups].sort((a, b) =>
        compare(a.id, b.id),
      ),
    }))
    .sort((a, b) => compare(stableJson(a), stableJson(b)));
}

/**
 * Sorts the IP ranges, and leaves out empty lists. Returns `undefined` for a
 * condition with no ranges, which Cloudflare reads the same as no condition.
 */
export function sortedCondition(
  condition: Token["condition"] | TokenCondition,
): TokenCondition | undefined {
  const requestIp: NonNullable<TokenCondition["request_ip"]> = {};
  for (const list of ["in", "not_in"] as const) {
    const ranges = condition?.request_ip?.[list];
    if (ranges?.length) requestIp[list] = [...ranges].sort();
  }
  return Object.keys(requestIp).length > 0
    ? { request_ip: requestIp }
    : undefined;
}

function toSeconds(time: string): string {
  return `${new Date(time).toISOString().slice(0, 19)}Z`;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => compare(a, b)),
        )
      : inner,
  );
}
