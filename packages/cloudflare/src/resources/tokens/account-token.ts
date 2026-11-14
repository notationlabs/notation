import * as v from "valibot";
import { writeSecretValues, type SecretTarget } from "@notation/core";
import {
  containsOutputRef,
  planLookup,
  resolveOutputRefs,
  resource,
  ResourceNotFoundError,
} from "@notation/resource";
import { sortedJson } from "@notation/utils";
import { cloudflareCreate } from "src/api/client";
import {
  createToken,
  deleteToken,
  findPermissionGroups,
  findTokensByName,
  getToken,
  updateToken,
  type Token,
  type TokenCondition,
  type TokenResources,
} from "src/api/tokens";
import type { SecretsStoreInstance } from "src/resources/secrets-store";
import { SECRETS_STORE_PROVIDER } from "src/resources/secrets-store/secrets-store-secret";

export const TOKEN_NAME_MAX_LENGTH = 120;

const policySchema = v.strictObject({
  effect: v.picklist(["allow", "deny"]),
  /**
   * The names of the permission groups, as Cloudflare lists them, such as
   * `Workers Scripts Write`. `deriveParams` replaces each name with its ID.
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

const conditionSchema = v.strictObject({
  /** The client IP ranges, in CIDR notation, that may or may not use the token. */
  requestIp: v.optional(
    v.strictObject({
      in: v.optional(v.array(v.string())),
      notIn: v.optional(v.array(v.string())),
    }),
  ),
});

export type AccountTokenCondition = v.InferOutput<typeof conditionSchema>;

// An ISO 8601 time in UTC, with or without milliseconds. `deriveParams`
// and the read both drop the milliseconds, so that the two compare equal.
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const timestampSchema = v.pipe(
  v.string(),
  v.regex(
    timestampPattern,
    "Use an ISO 8601 time in UTC, such as 2027-01-01T00:00:00Z",
  ),
  // The check passes a time in another format, which the regex reports.
  // `Date` reads a day past the end of the month as a day in the next month,
  // so the check compares the parsed time with the input.
  v.check(
    (time) =>
      !timestampPattern.test(time) ||
      (!Number.isNaN(Date.parse(time)) &&
        toSeconds(time) === `${time.slice(0, 19)}Z`),
    "Use a date and time that exist, such as 2027-02-28T00:00:00Z",
  ),
);

const targetSchema = v.object({
  provider: v.string(),
  params: v.record(v.string(), v.any()),
});

type AccountTokenParams = {
  AccountId: string;
  Name: string;
  Policies: AccountTokenPolicy[];
  Condition?: AccountTokenCondition;
  ExpiresOn?: string;
  NotBefore?: string;
  /** The secrets that create writes the token's value to. */
  ValueTargets: SecretTarget[];
};

export type AccountTokenSchema = {
  Key: { AccountId: string; TokenId: string; Name: string };
  CreateParams: AccountTokenParams;
  UpdateParams: Pick<
    AccountTokenParams,
    "Policies" | "Condition" | "ExpiresOn" | "NotBefore"
  >;
  ReadResult: {};
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
  Condition: {
    propertyType: "param",
    presence: "optional",
    value: conditionSchema,
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
  /**
   * The secrets that create writes the token's value to. Each secret whose
   * source is the token's `sources.value` contributes its target. It is
   * immutable, because only a create gets a value to write to a new target.
   */
  ValueTargets: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.array(targetSchema),
    collect: (items: unknown[]) => items.flat() as SecretTarget[],
    // Up to 0.20, the token wrote its value to the secret with its own name,
    // in the store `StoreId`, and its record held no targets.
    backfill: (recorded) => [
      {
        provider: SECRETS_STORE_PROVIDER,
        params: {
          AccountId: recorded.AccountId,
          StoreId: recorded.StoreId,
          Name: recorded.Name,
        },
      },
    ],
  },
  TokenId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
} as const);

/**
 * An account-owned API token. Cloudflare returns its value only in the
 * create's response, so create writes the value to each secret in
 * `ValueTargets` in the same step. The record holds where the secrets are,
 * and never the value. When a write fails, create deletes the values it
 * wrote and the new token.
 *
 * A create with an unknown outcome deletes the tokens with the name, and
 * runs again. A change to the policies, the condition or the times updates
 * the token in place, and the token keeps its value. A change to the name
 * or the targets replaces the token, which writes a new value to every
 * target. Delete deletes the token and leaves the secrets: each secret's
 * resource deletes its own value.
 *
 * A change made in the dashboard to the policies or the IP ranges is seen
 * as drift, and the deploy updates the token back to the config. A removed
 * expiry or not-before time is not seen as drift. The read doesn't check the
 * token's status, so a token that is disabled in the dashboard stays
 * disabled.
 */
export const AccountToken = accountTokenSchema
  .defineOperations({
    create: async (params) => {
      const token = await cloudflareCreate(createToken)(params.AccountId, {
        name: params.Name,
        policies: policyRequests(params.Policies),
        condition: conditionRequest(params.Condition),
        expires_on: params.ExpiresOn,
        not_before: params.NotBefore,
      });
      try {
        await writeSecretValues(
          params.ValueTargets.map((target) => [target, token.value]),
        );
      } catch (error) {
        // The value is lost when a write fails, so the token is deleted,
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
      // A missing secret is left to the secret's read, which reports it as
      // drift.
      return {
        ...key,
        Policies: sortedPolicies(
          token.policies.map((policy) => ({
            effect: policy.effect,
            permissionGroups: policy.permission_groups.map(({ id }) => id),
            resources: policy.resources,
          })),
        ),
        ...readTimes(token),
        // `{}` and not undefined, so that drift is seen when the IP ranges
        // are removed in the dashboard. A config without a condition is not
        // compared.
        Condition: sortedCondition(readCondition(token)) ?? {},
      };
    },

    // The update sends the whole config. It sends an empty condition and null
    // times when the config doesn't set them, to remove them from the token.
    update: async (key, _patch, params) => {
      await updateToken(key.AccountId, key.TokenId, {
        name: params.Name,
        policies: policyRequests(params.Policies),
        condition: conditionRequest(params.Condition) ?? {},
        expires_on: params.ExpiresOn ?? null,
        not_before: params.NotBefore ?? null,
      });
    },

    // A token that a replace deletes would otherwise delete the value that
    // its replacement wrote.
    delete: async (key) => {
      await deleteToken(key.AccountId, key.TokenId);
    },
  })
  .requireDependencies<AccountTokenDependencies>()
  .deriveParams(async ({ config, deps }) => {
    const { AccountId } = deps.store.output;
    const Policies = await resolvePolicies(AccountId, config.Policies);
    const derived: Partial<AccountTokenParams> = { Policies };
    // Config still holds output refs when this runs. `planLookup` replaces
    // each one whose resource has an output. A value that still holds an
    // output ref is left as it is.
    const resolve = <T>(value: T) => resolveOutputRefs(value, planLookup) as T;
    const condition = resolve(config.Condition);
    if (!containsOutputRef(condition)) {
      derived.Condition = sortedCondition(condition);
    }
    for (const field of ["ExpiresOn", "NotBefore"] as const) {
      const time = resolve(config[field]);
      if (time && !containsOutputRef(time)) derived[field] = toSeconds(time);
    }
    // The cast keeps the derived values out of the declared return type, so
    // that config keeps Policies with the groups' names.
    return { AccountId, ...derived } as Pick<
      typeof deps.store.output,
      "AccountId"
    >;
  });

export type AccountTokenInstance = InstanceType<typeof AccountToken>;

const policyRequests = (policies: AccountTokenPolicy[]) =>
  policies.map((policy) => ({
    effect: policy.effect,
    permission_groups: policy.permissionGroups.map((id) => ({ id })),
    resources: policy.resources,
  }));

const conditionRequest = (
  condition: AccountTokenCondition | undefined,
): TokenCondition | undefined =>
  condition?.requestIp && {
    request_ip: {
      in: condition.requestIp.in,
      not_in: condition.requestIp.notIn,
    },
  };

const readCondition = (token: Token): AccountTokenCondition => ({
  requestIp: {
    in: token.condition?.request_ip?.in ?? undefined,
    notIn: token.condition?.request_ip?.not_in ?? undefined,
  },
});

function readTimes(
  token: Token,
): Pick<AccountTokenParams, "ExpiresOn" | "NotBefore"> {
  const times: Pick<AccountTokenParams, "ExpiresOn" | "NotBefore"> = {};
  if (token.expires_on) times.ExpiresOn = toSeconds(token.expires_on);
  if (token.not_before) times.NotBefore = toSeconds(token.not_before);
  return times;
}

/** The policies, with each permission group's name replaced by its ID. */
async function resolvePolicies(
  account: string,
  policies: AccountTokenPolicy[],
): Promise<AccountTokenPolicy[]> {
  const resolved = policies.map(async (policy) => ({
    ...policy,
    permissionGroups: await Promise.all(
      policy.permissionGroups.map((name) =>
        groupId(account, name, policy.resources),
      ),
    ),
  }));
  return sortedPolicies(await Promise.all(resolved));
}

/**
 * A name can belong to one group for each scope. A resource's scope is its
 * key without the last part, or for an account that holds zones, the scope
 * of the zones.
 */
async function groupId(
  account: string,
  name: string,
  resources: TokenResources,
): Promise<string> {
  const groups = await findPermissionGroups(account, name);
  const scopes = Object.entries(resources)
    .flatMap(([key, value]) =>
      typeof value === "object" ? Object.keys(value) : [key],
    )
    .map((key) => key.slice(0, key.lastIndexOf(".")));
  const fits = groups.filter((group) =>
    scopes.every((scope) => group.scopes?.includes(scope)),
  );
  if (groups.length === 1 || fits.length === 1) {
    return (fits[0] ?? groups[0])!.id;
  }
  throw new Error(
    groups.length === 0
      ? `Cloudflare has no API token permission group named "${name}". Use the name that the dashboard shows when you create a token, such as "Workers Scripts Write".`
      : `More than one API token permission group is named "${name}", and the scope of the policy's resources doesn't pick one: ${groups.map((group) => `${group.id} (${group.scopes?.join(", ")})`).join(", ")}. Give each scope its own policy.`,
  );
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

/**
 * Sorts the IP ranges, and leaves out empty lists. Returns `undefined` for a
 * condition with no ranges, which Cloudflare reads the same as no condition.
 */
export function sortedCondition(
  condition: AccountTokenCondition | undefined,
): AccountTokenCondition | undefined {
  const requestIp: NonNullable<AccountTokenCondition["requestIp"]> = {};
  for (const list of ["in", "notIn"] as const) {
    const ranges = condition?.requestIp?.[list];
    if (ranges?.length) requestIp[list] = [...ranges].sort();
  }
  return Object.keys(requestIp).length > 0 ? { requestIp } : undefined;
}

function toSeconds(time: string): string {
  return `${new Date(time).toISOString().slice(0, 19)}Z`;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
