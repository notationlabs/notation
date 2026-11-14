import * as v from "valibot";
import { CloudflareApiError, cloudflare, cloudflareGetText } from "./client";

/** Cloudflare's error code for a KV namespace that doesn't exist. */
const NAMESPACE_NOT_FOUND = 10013;

/** Cloudflare's error code for a key that the namespace doesn't have. */
const KEY_NOT_FOUND = 10009;

/** Cloudflare's error code for a title that another namespace in the account has. */
const TITLE_TAKEN = 10014;

// The largest page that the list accepts.
const LIST_PAGE_SIZE = 1000;

export const jurisdictionSchema = v.picklist(["eu", "fedramp", "us"]);

export type Jurisdiction = v.InferOutput<typeof jurisdictionSchema>;

export type Namespace = {
  id: string;
  title: string;
  jurisdiction?: Jurisdiction | null;
};

export type NamespaceCreate = {
  title: string;
  jurisdiction?: Jurisdiction;
};

export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(NAMESPACE_NOT_FOUND);

const isKeyNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(KEY_NOT_FOUND);

export const isTitleTaken = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(TITLE_TAKEN);

const namespacesPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/storage/kv/namespaces`;

const namespacePath = (account: string, namespaceId: string) =>
  `${namespacesPath(account)}/${encodeURIComponent(namespaceId)}`;

/** Fails if the account has a namespace with the same title. */
export async function createNamespace(
  account: string,
  namespace: NamespaceCreate,
): Promise<Namespace> {
  return await cloudflare<Namespace>(
    "POST",
    namespacesPath(account),
    namespace,
  );
}

/** Returns `undefined` if the namespace doesn't exist. */
export async function getNamespace(
  account: string,
  namespaceId: string,
): Promise<Namespace | undefined> {
  try {
    return await cloudflare<Namespace>(
      "GET",
      namespacePath(account, namespaceId),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Returns `undefined` if the account has no namespace with the title. */
export async function findNamespaceByTitle(
  account: string,
  title: string,
): Promise<Namespace | undefined> {
  for (let page = 1; ; page++) {
    const namespaces = await cloudflare<Namespace[]>(
      "GET",
      `${namespacesPath(account)}?page=${page}&per_page=${LIST_PAGE_SIZE}&order=id&direction=asc`,
    );
    const found = namespaces.find((namespace) => namespace.title === title);
    if (found) return found;
    if (namespaces.length < LIST_PAGE_SIZE) return undefined;
  }
}

export async function renameNamespace(
  account: string,
  namespaceId: string,
  title: string,
): Promise<void> {
  await cloudflare("PUT", namespacePath(account, namespaceId), { title });
}

/** Deletes the namespace and every key in it. */
export async function deleteNamespace(
  account: string,
  namespaceId: string,
): Promise<void> {
  await cloudflare("DELETE", namespacePath(account, namespaceId));
}

const valuePath = (account: string, namespaceId: string, key: string) =>
  `${namespacePath(account, namespaceId)}/values/${encodeURIComponent(key)}`;

/** Writes the value of the key, as it is. */
export async function putKVValue(
  account: string,
  namespaceId: string,
  key: string,
  value: string,
): Promise<void> {
  const form = new FormData();
  // A Blob part is sent byte for byte. A string part would have each line
  // break turned into CRLF.
  form.set("value", new Blob([value]));
  await cloudflare("PUT", valuePath(account, namespaceId, key), form);
}

/**
 * Returns the value of the key as UTF-8 text, or `undefined` if the namespace
 * has no such key. KV is eventually consistent, so the value can be up to
 * about 60 seconds old.
 */
export async function getKVValue(
  account: string,
  namespaceId: string,
  key: string,
): Promise<string | undefined> {
  try {
    return await cloudflareGetText(valuePath(account, namespaceId, key));
  } catch (error) {
    if (isKeyNotFound(error)) return undefined;
    throw error;
  }
}

/** Succeeds if the namespace has no such key. */
export async function deleteKVValue(
  account: string,
  namespaceId: string,
  key: string,
): Promise<void> {
  try {
    await cloudflare("DELETE", valuePath(account, namespaceId, key));
  } catch (error) {
    if (!isKeyNotFound(error)) throw error;
  }
}
