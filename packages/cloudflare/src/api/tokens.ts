import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a token that doesn't exist. */
const TOKEN_NOT_FOUND = 1003;

/** Cloudflare's error code for an authentication error. */
const AUTHENTICATION_ERROR = 10000;

const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(TOKEN_NOT_FOUND);

/**
 * The resources that a policy applies to, such as
 * `{ "com.cloudflare.api.account.<account id>": "*" }`.
 */
export type TokenResources = Record<string, string | Record<string, string>>;

export type TokenPolicyRequest = {
  effect: "allow" | "deny";
  permission_groups: { id: string }[];
  resources: TokenResources;
};

export type TokenRequest = {
  name: string;
  policies: TokenPolicyRequest[];
};

/** The fields of a token that the read uses. */
export type Token = {
  name: string;
  policies?: {
    effect: "allow" | "deny";
    permission_groups: { id: string; name?: string }[];
    resources: TokenResources;
  }[];
};

export type PermissionGroup = { id: string; name: string };

const tokensPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/tokens`;

const tokenPath = (account: string, tokenId: string) =>
  `${tokensPath(account)}/${encodeURIComponent(tokenId)}`;

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

/** Replaces the token's name and policies. The token keeps its value. */
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

/** The permission groups whose name is `name`. */
export async function findPermissionGroups(
  account: string,
  name: string,
): Promise<PermissionGroup[]> {
  const query = new URLSearchParams({ name });
  let groups: PermissionGroup[] | null;
  try {
    groups = await cloudflare<PermissionGroup[] | null>(
      "GET",
      `${tokensPath(account)}/permission_groups?${query}`,
    );
  } catch (error) {
    throw withPermissionHint(error);
  }
  // The filter may match part of a name, so each result is compared.
  return (groups ?? []).filter((group) => group.name === name);
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
