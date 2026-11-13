import * as v from "valibot";
import { CloudflareApiError, cloudflare, cloudflareList } from "./client";

/** Cloudflare's error code for a token that doesn't exist. */
const TOKEN_NOT_FOUND = 1003;

/** Cloudflare's error code for an authentication error. */
const AUTHENTICATION_ERROR = 10000;

const PAGE_SIZE = 100;

const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(TOKEN_NOT_FOUND);

export type PermissionGroup = {
  id: string;
  name: string;
  scopes?: string[];
  category?: string;
  is_selectable?: boolean;
};

export const tokenPermissionGroupRefSchema = v.union([
  v.strictObject({ id: v.string() }),
  v.pipe(v.string(), v.nonEmpty()),
]);

export type TokenPermissionGroupRef = v.InferOutput<
  typeof tokenPermissionGroupRefSchema
>;

export const tokenPolicySchema = v.strictObject({
  effect: v.picklist(["allow", "deny"]),
  /**
   * The permission groups, by ID. `GET /accounts/<id>/tokens/permission_groups`
   * lists the IDs.
   */
  permission_groups: v.pipe(
    v.array(v.strictObject({ id: v.string() })),
    v.minLength(1),
  ),
  /**
   * The resources that the policy applies to, such as
   * `{ "com.cloudflare.api.account.*": "*" }`.
   */
  resources: v.record(
    v.string(),
    v.union([v.string(), v.record(v.string(), v.string())]),
  ),
});

export type TokenPolicy = v.InferOutput<typeof tokenPolicySchema>;

export const tokenPolicyInputSchema = v.strictObject({
  effect: v.picklist(["allow", "deny"]),
  permission_groups: v.pipe(
    v.array(tokenPermissionGroupRefSchema),
    v.minLength(1),
  ),
  resources: v.record(
    v.string(),
    v.union([v.string(), v.record(v.string(), v.string())]),
  ),
});

export type TokenPolicyInput = v.InferOutput<typeof tokenPolicyInputSchema>;

export const tokenConditionSchema = v.strictObject({
  /** The client IP ranges, in CIDR notation, that may or may not use the token. */
  request_ip: v.optional(
    v.strictObject({
      in: v.optional(v.array(v.string())),
      not_in: v.optional(v.array(v.string())),
    }),
  ),
});

export type TokenCondition = v.InferOutput<typeof tokenConditionSchema>;

export type TokenRequest = {
  name: string;
  policies: TokenPolicy[];
  condition?: TokenCondition;
  // null removes the time from the token.
  expires_on?: string | null;
  not_before?: string | null;
};

/** The fields of a token that the read uses. */
export type Token = {
  name: string;
  policies?: {
    effect: "allow" | "deny";
    permission_groups: { id: string }[];
    resources: TokenPolicy["resources"];
  }[];
  condition?: {
    request_ip?: { in?: string[] | null; not_in?: string[] | null } | null;
  } | null;
  expires_on?: string | null;
  not_before?: string | null;
};

const tokensPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/tokens`;

const tokenPath = (account: string, tokenId: string) =>
  `${tokensPath(account)}/${encodeURIComponent(tokenId)}`;

/** Lists all permission groups available for account-owned API tokens. */
export async function listPermissionGroups(
  account: string,
): Promise<PermissionGroup[]> {
  const groups: PermissionGroup[] = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    try {
      const { result, resultInfo } = await cloudflareList<
        PermissionGroup[] | null
      >(`${tokensPath(account)}/permission_groups?${query}`);
      const items = result ?? [];
      groups.push(...items);
      const totalPages = resultInfo?.total_pages;
      const perPage = resultInfo?.per_page ?? PAGE_SIZE;
      if (items.length === 0) break;
      if (totalPages !== undefined) {
        if (page >= totalPages) break;
      } else if (items.length < perPage) {
        break;
      }
    } catch (error) {
      throw withPermissionHint(error);
    }
  }
  return groups;
}

/**
 * Creates an account-owned API token. The response is the only one that
 * holds the token's value.
 */
export async function createToken(
  account: string,
  request: TokenRequest,
): Promise<{ id: string; value: string }> {
  try {
    return await cloudflare<{ id: string; value: string }>(
      "POST",
      tokensPath(account),
      request,
    );
  } catch (error) {
    throw withPermissionHint(error);
  }
}

/** Returns `undefined` if the token doesn't exist. */
export async function getToken(
  account: string,
  tokenId: string,
): Promise<Token | undefined> {
  try {
    return await cloudflare<Token>("GET", tokenPath(account, tokenId));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw withPermissionHint(error);
  }
}

/**
 * Replaces the token's name, policies, condition and times. The token keeps
 * its ID and value. Fails if the token doesn't exist.
 */
export async function updateToken(
  account: string,
  tokenId: string,
  request: TokenRequest,
): Promise<void> {
  try {
    await cloudflare("PUT", tokenPath(account, tokenId), request);
  } catch (error) {
    throw withPermissionHint(error);
  }
}

/** Does nothing if the token doesn't exist. */
export async function deleteToken(
  account: string,
  tokenId: string,
): Promise<void> {
  try {
    await cloudflare("DELETE", tokenPath(account, tokenId));
  } catch (error) {
    if (isNotFound(error)) return;
    throw withPermissionHint(error);
  }
}

function withPermissionHint(error: unknown): unknown {
  if (
    error instanceof CloudflareApiError &&
    (error.status === 403 || error.hasCode(AUTHENTICATION_ERROR))
  ) {
    error.message +=
      ". If the API token is valid, it needs the Account API Tokens: Edit permission.";
  }
  return error;
}
