import { cloudflare } from "./client";

type DurableObjectNamespace = {
  id: string;
  class?: string;
  script?: string;
  preview?: unknown;
  dispatch_namespace?: string;
};

const PAGE_SIZE = 1_000;

/**
 * Returns the IDs of the Durable Object namespaces that the Worker
 * `scriptName` hosts, by class name. It skips the namespaces of previews and
 * of Workers for Platforms dispatch namespaces, which can have the same
 * script and class.
 */
export async function listScriptNamespaces(
  account: string,
  scriptName: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (let page = 1; ; page++) {
    const namespaces =
      (await cloudflare<DurableObjectNamespace[] | null>(
        "GET",
        `/accounts/${encodeURIComponent(account)}/workers/durable_objects/namespaces?page=${page}&per_page=${PAGE_SIZE}`,
      )) ?? [];
    for (const namespace of namespaces) {
      if (
        namespace.script === scriptName &&
        namespace.class &&
        namespace.preview === undefined &&
        namespace.dispatch_namespace === undefined
      ) {
        ids[namespace.class] = namespace.id;
      }
    }
    if (namespaces.length < PAGE_SIZE) return ids;
  }
}
