import * as v from "valibot";
import {
  containsOutputRef,
  planLookup,
  resolveOutputRefs,
  resource,
  ResourceNotFoundError,
  type PhysicalNameRule,
} from "@notation/resource";
import { sortedJson } from "@notation/utils";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  createToken,
  deleteToken,
  findPermissionGroups,
  findTokensByName,
  getToken,
  rollToken,
  updateToken,
  type Token,
  type TokenCondition,
  type TokenResources,
} from "src/api/tokens";

export const TOKEN_NAME_MAX_LENGTH = 120;

/** The rule of a token's generated name, `<app>--<stage>--<id>-<instance>`. */
export const tokenNameRule: PhysicalNameRule = {
  maxLength: TOKEN_NAME_MAX_LENGTH,
};

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

type AccountTokenParams = {
  AccountId: string;
  Name: string;
  Policies: AccountTokenPolicy[];
  Condition?: AccountTokenCondition;
  ExpiresOn?: string;
  NotBefore?: string;
};

export type AccountTokenSchema = {
  Key: { AccountId: string; TokenId: string };
  CreateParams: AccountTokenParams;
  UpdateParams: Pick<
    AccountTokenParams,
    "Policies" | "Condition" | "ExpiresOn" | "NotBefore"
  >;
  ReadResult: {};
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
    value: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(TOKEN_NAME_MAX_LENGTH),
    ),
    physicalName: tokenNameRule,
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
  TokenId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  /**
   * The token's value. Cloudflare returns it when it creates the token and
   * when it rolls it, and never otherwise.
   */
  Value: { propertyType: "credential", value: v.string() },
} as const);

/**
 * An account-owned API token, which deploy names
 * `<app>--<stage>--<id>-<instance>`. Its value is the credential `Value`, which
 * another resource takes with `token.credentials.Value`. State never holds
 * the value.
 *
 * A create with an unknown outcome deletes the tokens with the name, and
 * runs again, as the value of a token made then is lost. A change to the
 * policies, the condition or the times updates the token in place, and the
 * token keeps its value. When a resource that takes the value needs it and
 * deploy no longer holds it, deploy rolls the token.
 *
 * A change made in the dashboard to the policies or the IP ranges is seen
 * as drift, and the deploy updates the token back to the config. A removed
 * expiry or not-before time is not seen as drift. The read doesn't check the
 * token's status, so a token that is disabled in the dashboard stays
 * disabled.
 */
export const AccountToken = accountTokenSchema.defineOperations({
  create: async (params) => {
    const token = await cloudflareCreate(createToken)(params.AccountId, {
      name: params.Name,
      policies: policyRequests(params.Policies),
      condition: conditionRequest(params.Condition),
      expires_on: params.ExpiresOn,
      not_before: params.NotBefore,
    });
    return { TokenId: token.id, Value: token.value };
  },

  rotate: {
    Value: (key) => rollToken(key.AccountId, key.TokenId),
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

  delete: async (key) => {
    await deleteToken(key.AccountId, key.TokenId);
  },

  deriveParams: async ({ config }) => {
    const AccountId = accountId();
    const Policies = await resolvePolicies(AccountId, config.Policies!);
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
    return { AccountId, ...derived } as { AccountId: string };
  },
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
