import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a KV namespace that doesn't exist. */
const NAMESPACE_NOT_FOUND = 10013;

/** Cloudflare's error code for a title that another namespace in the account has. */
const TITLE_TAKEN = 10014;

// The largest page that the list accepts.
const LIST_PAGE_SIZE = 1000;

export type Jurisdiction = "eu" | "fedramp" | "us";

export type Mode = "instant";

export type Namespace = {
  id: string;
  title: string;
  jurisdiction?: Jurisdiction | null;
  mode?: Mode | null;
};

export type NamespaceCreate = {
  title: string;
  jurisdiction?: Jurisdiction;
  mode?: Mode;
};

export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(NAMESPACE_NOT_FOUND);

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
    const namespaces = await cloudflare<Namespace[] | null>(
      "GET",
      `${namespacesPath(account)}?page=${page}&per_page=${LIST_PAGE_SIZE}`,
    );
    const found = namespaces?.find((namespace) => namespace.title === title);
    if (found) return found;
    if (!namespaces || namespaces.length < LIST_PAGE_SIZE) return undefined;
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
