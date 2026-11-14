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

// The most keys that one bulk write or bulk delete accepts.
const BULK_SIZE = 10_000;

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

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type KVWriteOptions = {
  /** Stored with the key, as JSON. */
  metadata?: JsonValue;
  /** When the key expires, in seconds since the UNIX epoch. */
  expiration?: number;
  /** Seconds until the key expires. Cloudflare's minimum is 60. */
  expirationTtl?: number;
};

export type KVEntry = KVWriteOptions & {
  key: string;
  /** A string is stored as it is. Any other value is stored as JSON. */
  value: JsonValue;
};

type BulkResult = {
  successful_key_count?: number;
  unsuccessful_keys?: string[];
};

const valuePath = (account: string, namespaceId: string, key: string) =>
  `${namespacePath(account, namespaceId)}/values/${encodeURIComponent(key)}`;

const encode = (value: JsonValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * Writes the value of the key. It replaces the value, metadata and
 * expiration that the key had.
 */
export async function putKVValue(
  account: string,
  namespaceId: string,
  key: string,
  /** A string is stored as it is. Any other value is stored as JSON. */
  value: JsonValue,
  options: KVWriteOptions = {},
): Promise<void> {
  const query = new URLSearchParams();
  if (options.expiration !== undefined) {
    query.set("expiration", String(options.expiration));
  }
  if (options.expirationTtl !== undefined) {
    query.set("expiration_ttl", String(options.expirationTtl));
  }
  const form = new FormData();
  // A Blob part is sent byte for byte. A string part would have each line
  // break turned into CRLF.
  form.set("value", new Blob([encode(value)]));
  if (options.metadata !== undefined) {
    form.set("metadata", JSON.stringify(options.metadata));
  }
  const search = query.size > 0 ? `?${query}` : "";
  await cloudflare(
    "PUT",
    `${valuePath(account, namespaceId, key)}${search}`,
    form,
  );
}

/**
 * Returns the value of the key as UTF-8 text, or parsed as JSON when `type`
 * is `"json"`. Returns `undefined` if the namespace has no such key. Throws if
 * `type` is `"json"` and the value isn't JSON. KV is eventually consistent,
 * so the value can be up to about 60 seconds old.
 */
export async function getKVValue(
  account: string,
  namespaceId: string,
  key: string,
  type?: "text",
): Promise<string | undefined>;
export async function getKVValue(
  account: string,
  namespaceId: string,
  key: string,
  type: "json",
): Promise<JsonValue | undefined>;
export async function getKVValue(
  account: string,
  namespaceId: string,
  key: string,
  type: "text" | "json" = "text",
): Promise<JsonValue | undefined> {
  let text: string;
  try {
    text = await cloudflareGetText(valuePath(account, namespaceId, key));
  } catch (error) {
    if (isKeyNotFound(error)) return undefined;
    throw error;
  }
  if (type === "text") return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The value of the KV key ${JSON.stringify(key)} isn't JSON`,
      {
        cause: error,
      },
    );
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

/**
 * Writes the entries in requests of up to 10,000 keys. Cloudflare also
 * limits a request to 100 MB. Throws if Cloudflare reports keys that it
 * didn't write. The keys of earlier requests stay written.
 */
export async function putKVValues(
  account: string,
  namespaceId: string,
  entries: KVEntry[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += BULK_SIZE) {
    const body = entries.slice(i, i + BULK_SIZE).map((entry) => ({
      key: entry.key,
      value: encode(entry.value),
      metadata: entry.metadata,
      expiration: entry.expiration,
      expiration_ttl: entry.expirationTtl,
    }));
    const result = await cloudflare<BulkResult | null>(
      "PUT",
      `${namespacePath(account, namespaceId)}/bulk`,
      body,
    );
    assertEveryKey("write", result);
  }
}

/**
 * Deletes the keys in requests of up to 10,000 keys. A key that the
 * namespace doesn't have counts as deleted. Throws if Cloudflare reports keys
 * that it didn't delete.
 */
export async function deleteKVValues(
  account: string,
  namespaceId: string,
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += BULK_SIZE) {
    const result = await cloudflare<BulkResult | null>(
      "POST",
      `${namespacePath(account, namespaceId)}/bulk/delete`,
      keys.slice(i, i + BULK_SIZE),
    );
    assertEveryKey("delete", result);
  }
}

function assertEveryKey(action: string, result: BulkResult | null): void {
  const failed = result?.unsuccessful_keys ?? [];
  if (failed.length === 0) return;
  const shown = failed.slice(0, 10).map((key) => JSON.stringify(key));
  if (failed.length > 10) shown.push("...");
  throw new Error(
    `Cloudflare didn't ${action} ${failed.length} of the KV keys. Send them again: ${shown.join(", ")}`,
  );
}
