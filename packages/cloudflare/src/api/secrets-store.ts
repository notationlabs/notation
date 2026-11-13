import { CloudflareApiError, cloudflare, cloudflareList } from "./client";

// Cloudflare returns these codes for several errors each. The message names
// the error, such as `secret_not_found`.
const INVALID_REQUEST = 1001;

// The most items that a page of the list can hold.
const PAGE_SIZE = 100;

export type Store = {
  id: string;
  name: string;
  account_id?: string;
  created?: string;
  modified?: string;
};

export const secretScopes = [
  "workers",
  "ai_gateway",
  "dex",
  "access",
  "containers",
  "websearch",
] as const;

export type SecretScope = (typeof secretScopes)[number];

export type StoreSecret = {
  id: string;
  name: string;
  status: "pending" | "active" | "deleted";
  comment?: string | null;
  /** Null when the secret inherits the scopes of its store. */
  scopes?: SecretScope[] | null;
};

export type SecretInput = {
  value: string;
  comment?: string;
  /** Null removes the scopes, so the secret inherits the scopes of its store. */
  scopes?: SecretScope[] | null;
};

// The code and the message must match in the same error item, which
// `hasCode` and `hasMessage` can't check.
const hasError = (error: unknown, code: number, name: string): boolean =>
  error instanceof CloudflareApiError &&
  error.errors.some(
    (item) => item.code === code && item.message.includes(name),
  );

const matchesError = (
  error: unknown,
  predicate: (err: unknown) => boolean,
): boolean => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) return true;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
};

const isDirectStoreNotFound = (error: unknown): boolean =>
  hasError(error, INVALID_REQUEST, "store_not_found") ||
  (error instanceof CloudflareApiError &&
    error.status === 404 &&
    error.hasMessage(/store_not_found|store .*not found/i));

const isDirectSecretNotFound = (error: unknown): boolean =>
  hasError(error, INVALID_REQUEST, "secret_not_found") ||
  (error instanceof CloudflareApiError &&
    error.status === 404 &&
    error.hasMessage(/secret_not_found|secret .*not found/i));

export const isStoreNotFound = (error: unknown): boolean =>
  matchesError(error, isDirectStoreNotFound);

export const isSecretNotFound = (error: unknown): boolean =>
  matchesError(error, isDirectSecretNotFound);

/**
 * True for a secret, or the store of a secret, that doesn't exist. Cloudflare
 * also returns code 1000 for "not found", but that code doesn't say what is
 * missing, so it doesn't count.
 */
export const isNotFound = (error: unknown): boolean =>
  isStoreNotFound(error) || isSecretNotFound(error);

const storesPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/secrets_store/stores`;

const storePath = (account: string, store: string) =>
  `${storesPath(account)}/${encodeURIComponent(store)}`;

const secretPath = (account: string, store: string, secretId: string) =>
  `${storePath(account, store)}/secrets/${encodeURIComponent(secretId)}`;

/** Lists the Secrets Stores in the account. */
export async function listStores(account: string): Promise<Store[]> {
  const stores: Store[] = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    const { result, resultInfo } = await cloudflareList<Store[] | null>(
      `${storesPath(account)}?${query}`,
    );
    const items = result ?? [];
    stores.push(...items);
    const totalPages = resultInfo?.total_pages;
    if (items.length === 0) break;
    if (totalPages !== undefined) {
      if (page >= totalPages) break;
    } else if (items.length < PAGE_SIZE) {
      break;
    }
  }
  return stores;
}

/** Returns `undefined` if the store doesn't exist. */
export async function getStore(
  account: string,
  storeId: string,
): Promise<Store | undefined> {
  try {
    return await cloudflare<Store>("GET", storePath(account, storeId));
  } catch (error) {
    if (isStoreNotFound(error)) return undefined;
    throw error;
  }
}

/** Creates a Secrets Store in the account. */
export async function createStore(
  account: string,
  name = "default_secrets_store",
): Promise<Store> {
  return await cloudflare<Store>("POST", storesPath(account), { name });
}

/**
 * Creates a secret and returns it, or `undefined` if the response has no
 * secret. Cloudflare rejects a name that another secret in the store has.
 */
export async function createSecret(
  account: string,
  store: string,
  name: string,
  input: SecretInput,
): Promise<StoreSecret | undefined> {
  // The create takes a list of secrets. This sends a list of one.
  const secrets = await cloudflare<StoreSecret[] | null>(
    "POST",
    `${storePath(account, store)}/secrets`,
    [{ name, ...input }],
  );
  return secrets?.[0];
}

/**
 * Returns `undefined` if the secret or its store doesn't exist, or if the
 * secret has the status `deleted`.
 */
export async function getSecret(
  account: string,
  store: string,
  secretId: string,
): Promise<StoreSecret | undefined> {
  let secret: StoreSecret;
  try {
    secret = await cloudflare<StoreSecret>(
      "GET",
      secretPath(account, store, secretId),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return secret.status === "deleted" ? undefined : secret;
}

/**
 * Returns the secret named `name` in the store, or `undefined` if there is
 * none. A secret with the status `deleted` doesn't count. Throws if the store
 * doesn't exist.
 */
export async function findSecretByName(
  account: string,
  store: string,
  name: string,
): Promise<StoreSecret | undefined> {
  // `search` also matches part of a name or a comment, so each result is
  // compared with the name. The first page is page 1, as in Cloudflare's
  // example response.
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      search: name,
      order: "name",
      direction: "asc",
      page: String(page),
      per_page: String(PAGE_SIZE),
    });
    let secrets: StoreSecret[];
    let totalPages: number | undefined;
    try {
      const { result, resultInfo } = await cloudflareList<StoreSecret[] | null>(
        `${storePath(account, store)}/secrets?${query}`,
      );
      secrets = result ?? [];
      totalPages = resultInfo?.total_pages;
    } catch (error) {
      if (isStoreNotFound(error)) {
        throw new Error(
          `The Secrets Store ${store} doesn't exist in the Cloudflare account ${account}.`,
          { cause: error },
        );
      }
      throw error;
    }
    const secret = secrets.find(
      (item) => item.name === name && item.status !== "deleted",
    );
    if (secret) return secret;
    if (secrets.length === 0) return undefined;
    if (totalPages !== undefined) {
      if (page >= totalPages) return undefined;
    } else if (secrets.length < PAGE_SIZE) {
      return undefined;
    }
  }
}

/**
 * Sets the value, and optionally the comment and scopes, of a secret.
 * Omitting `scopes` keeps the secret's existing scopes.
 */
export async function patchSecret(
  account: string,
  store: string,
  secretId: string,
  input: SecretInput,
): Promise<void> {
  await cloudflare("PATCH", secretPath(account, store, secretId), input);
}

export async function deleteSecret(
  account: string,
  store: string,
  secretId: string,
): Promise<void> {
  await cloudflare("DELETE", secretPath(account, store, secretId));
}
