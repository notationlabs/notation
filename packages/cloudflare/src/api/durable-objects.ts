import { cloudflare } from "./client";

type DurableObjectNamespace = {
  id: string;
  class?: string;
  script?: string;
};

const PAGE_SIZE = 1_000;

/**
 * Returns the IDs of the Durable Object namespaces that the Worker
 * `scriptName` hosts, by class name.
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
      if (namespace.script === scriptName && namespace.class) {
        ids[namespace.class] = namespace.id;
      }
    }
    if (namespaces.length < PAGE_SIZE) return ids;
  }
}
