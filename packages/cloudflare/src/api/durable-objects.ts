import { cloudflare } from "./client";

type DurableObjectNamespace = {
  id: string;
  class?: string;
  script?: string;
  preview?: unknown;
  dispatch_namespace?: string;
};

const PAGE_SIZE = 1_000;

// A stop for an API that never returns an empty page.
const MAX_PAGES = 100;

/**
 * Returns the ID of the Durable Object namespace for the class `className`
 * that the Worker `scriptName` hosts, or `undefined` if Cloudflare lists none.
 * It skips the namespaces of previews and of Workers for Platforms dispatch
 * namespaces, which can have the same script and class.
 */
export async function findScriptNamespace(
  account: string,
  scriptName: string,
  className: string,
): Promise<string | undefined> {
  // Cloudflare may return fewer namespaces than `per_page`, so only an empty
  // page ends the list.
  for (let page = 1; page <= MAX_PAGES; page++) {
    const namespaces =
      (await cloudflare<DurableObjectNamespace[] | null>(
        "GET",
        `/accounts/${encodeURIComponent(account)}/workers/durable_objects/namespaces?page=${page}&per_page=${PAGE_SIZE}`,
      )) ?? [];
    if (namespaces.length === 0) return undefined;
    const namespace = namespaces.find(
      (namespace) =>
        namespace.script === scriptName &&
        namespace.class === className &&
        namespace.preview === undefined &&
        namespace.dispatch_namespace === undefined,
    );
    if (namespace) return namespace.id;
  }
  throw new Error(
    `Cloudflare listed more than ${MAX_PAGES} pages of Durable Object namespaces without finding the class ${className} of the Worker ${scriptName}.`,
  );
}
