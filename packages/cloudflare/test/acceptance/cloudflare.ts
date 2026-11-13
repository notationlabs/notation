import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const API_URL = "https://api.cloudflare.com/client/v4";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

/** True when the credentials for the acceptance tests are set. */
export const hasCredentials = Boolean(accountId && apiToken);

/**
 * Starts the name of everything that a run of the acceptance tests creates, so
 * that leftovers can be found and two runs don't collide.
 */
export const runPrefix = `nacc-${crypto.randomBytes(3).toString("hex")}`;

export type ApiResponse<T> = {
  status: number;
  success: boolean;
  errors: { code?: number; message: string }[];
  result: T;
};

/** Calls the Cloudflare API, and returns the envelope instead of throwing. */
export async function api<T = any>(
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  /** The path after `/accounts/<id>`. */
  path: string,
  body?: FormData | object,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
  };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${API_URL}/accounts/${accountId}${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await response.text();
  let envelope: any = {};
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = { errors: [{ message: text.slice(0, 200) }] };
  }
  return {
    status: response.status,
    success: response.ok && envelope.success !== false,
    errors: envelope.errors ?? [],
    result: envelope.result,
  };
}

export async function accountSubdomain(): Promise<string> {
  const response = await api<{ subdomain: string }>(
    "GET",
    "/workers/subdomain",
  );
  if (!response.success) {
    throw new Error(
      `The account has no workers.dev subdomain: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result.subdomain;
}

/** The names of the account's Workers that start with `prefix`. */
export async function scriptsWithPrefix(prefix: string): Promise<string[]> {
  const response = await api<{ id: string }[]>("GET", "/workers/scripts");
  if (!response.success) {
    throw new Error(
      `Listing Workers failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result
    .map((script) => script.id)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

export type AccountNamespace = { script: string; class: string };

/** The account's Durable Object namespaces whose Worker starts with `prefix`. */
export async function namespacesWithPrefix(
  prefix: string,
): Promise<AccountNamespace[]> {
  const found: AccountNamespace[] = [];
  for (let page = 1; ; page++) {
    const response = await api<AccountNamespace[]>(
      "GET",
      `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
    );
    if (!response.success) {
      throw new Error(
        `Listing namespaces failed: ${JSON.stringify(response.errors)}`,
      );
    }
    if (!response.result?.length) break;
    for (const namespace of response.result) {
      if (namespace.script?.startsWith(prefix)) {
        found.push({ script: namespace.script, class: namespace.class });
      }
    }
  }
  return found;
}

/** Deletes each Worker that starts with `prefix`, with `force`. */
export async function deleteScriptsWithPrefix(prefix: string): Promise<void> {
  for (const name of await scriptsWithPrefix(prefix)) {
    await api("DELETE", `/workers/scripts/${name}?force=true`);
  }
}

/** Uploads a Worker that answers each request with `ok <hostname>`. */
export async function uploadScript(name: string): Promise<ApiResponse<any>> {
  const code = `export default { fetch(request) { return new Response("ok " + new URL(request.url).hostname); } };`;
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "index.mjs",
      compatibility_date: "2026-10-12",
    }),
  );
  form.set(
    "index.mjs",
    new File([code], "index.mjs", { type: "application/javascript+module" }),
  );
  return api("PUT", `/workers/scripts/${name}`, form);
}

/** The ID of the Worker's latest version. */
export async function latestVersionId(name: string): Promise<string> {
  const response = await api<{ items: { id: string }[] }>(
    "GET",
    `/workers/scripts/${name}/versions`,
  );
  const id = response.result?.items?.[0]?.id;
  if (!id) {
    throw new Error(
      `${name} has no versions: ${JSON.stringify(response.errors)}`,
    );
  }
  return id;
}

export type Fetched = {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};

/**
 * Requests `url` until it answers with a 2xx status or `timeoutMs` passes,
 * as a new workers.dev hostname takes a while to be served. Returns the last
 * response or error.
 */
export async function poll(
  url: string,
  {
    timeoutMs = 120_000,
    init,
  }: { timeoutMs?: number; init?: RequestInit } = {},
): Promise<Fetched> {
  const deadline = Date.now() + timeoutMs;
  let last: Fetched = { ok: false };
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      last = {
        ok: response.ok,
        status: response.status,
        body: (await response.text()).slice(0, 500),
      };
      if (response.ok) return last;
    } catch (error) {
      const cause = (error as Error & { cause?: any }).cause;
      last = {
        ok: false,
        error: `${(error as Error).name}: ${cause?.code ?? cause?.message ?? (error as Error).message}`,
      };
    }
    await sleep(3_000);
  }
  return last;
}
