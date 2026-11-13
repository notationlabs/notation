import { CloudflareApiError, cloudflare, cloudflareList } from "./client";

// Cloudflare returns this code for several errors. The message names the
// error, such as `secret_not_found`.
const INVALID_REQUEST = 1001;

const PAGE_SIZE = 100;

/** The name that the dashboard gives the store it creates. */
export const DEFAULT_STORE_NAME = "default_secrets_store";

export type Store = { id: string; name: string };

export type StoreSecret = {
  id: string;
  name: string;
  status: "pending" | "active" | "deleted";
};

// The code and the message must match in the same error item, which
// `hasCode` and `hasMessage` can't check.
const hasError = (error: unknown, code: number, name: string): boolean =>
  error instanceof CloudflareApiError &&
  error.errors.some(
    (item) => item.code === code && item.message.includes(name),
  );

export const isStoreNotFound = (error: unknown): boolean =>
  hasError(error, INVALID_REQUEST, "store_not_found");

const isSecretNotFound = (error: unknown): boolean =>
  hasError(error, INVALID_REQUEST, "secret_not_found");

const storesPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/secrets_store/stores`;

const storePath = (account: string, store: string) =>
  `${storesPath(account)}/${encodeURIComponent(store)}`;

const secretPath = (account: string, store: string, secretId: string) =>
  `${storePath(account, store)}/secrets/${encodeURIComponent(secretId)}`;

/** Returns the account's stores. Cloudflare allows one per account. */
export async function listStores(account: string): Promise<Store[]> {
  return (await cloudflare<Store[] | null>("GET", storesPath(account))) ?? [];
}

/** Returns `undefined` if the store doesn't exist. */
export async function getStore(
  account: string,
  store: string,
): Promise<Store | undefined> {
  try {
    return await cloudflare<Store>("GET", storePath(account, store));
  } catch (error) {
    if (isStoreNotFound(error)) return undefined;
    throw error;
  }
}

export async function createStore(
  account: string,
  name: string,
): Promise<Store> {
  return await cloudflare<Store>("POST", storesPath(account), { name });
}

/**
 * Returns the secret named `name` in the store, or `undefined` if there is
 * none, or if the store doesn't exist. A secret with the status `deleted`
 * doesn't count.
 */
export async function findSecretByName(
  account: string,
  store: string,
  name: string,
): Promise<StoreSecret | undefined> {
  // `search` also matches part of a name or a comment, so each result is
  // compared with the name.
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
      if (isStoreNotFound(error)) return undefined;
      throw error;
    }
    const secret = secrets.find(
      (item) => item.name === name && item.status !== "deleted",
    );
    if (secret) return secret;
    if (secrets.length < PAGE_SIZE) return undefined;
    if (totalPages !== undefined && page >= totalPages) return undefined;
  }
}

/**
 * Creates a secret that Workers can bind. Cloudflare rejects a name that
 * another secret in the store has.
 */
export async function createSecret(
  account: string,
  store: string,
  name: string,
  value: string,
): Promise<StoreSecret | undefined> {
  // The create takes a list of secrets. This sends a list of one.
  const secrets = await cloudflare<StoreSecret[] | null>(
    "POST",
    `${storePath(account, store)}/secrets`,
    [{ name, value, scopes: ["workers"] }],
  );
  return secrets?.[0];
}

/** Sets a secret's value. The secret keeps its scopes and comment. */
export async function setSecretValue(
  account: string,
  store: string,
  secretId: string,
  value: string,
): Promise<void> {
  await cloudflare("PATCH", secretPath(account, store, secretId), { value });
}

/**
 * Writes `value` to the secret named `name`: it creates the secret, or sets
 * the value of the one that exists.
 */
export async function writeSecret(
  account: string,
  store: string,
  name: string,
  value: string,
): Promise<void> {
  const existing = await findSecretByName(account, store, name);
  if (existing) {
    await setSecretValue(account, store, existing.id, value);
  } else {
    await createSecret(account, store, name, value);
  }
}

/** Does nothing if the secret or its store doesn't exist. */
export async function deleteSecret(
  account: string,
  store: string,
  secretId: string,
): Promise<void> {
  try {
    await cloudflare("DELETE", secretPath(account, store, secretId));
  } catch (error) {
    if (isSecretNotFound(error) || isStoreNotFound(error)) return;
    throw error;
  }
}

/** Does nothing if no secret has the name. */
export async function deleteSecretByName(
  account: string,
  store: string,
  name: string,
): Promise<void> {
  const secret = await findSecretByName(account, store, name);
  if (secret) await deleteSecret(account, store, secret.id);
}
