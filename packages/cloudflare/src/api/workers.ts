import * as v from "valibot";
import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a Worker that doesn't exist. */
const WORKER_NOT_FOUND = 10007;

/**
 * Cloudflare's error code for an account with no workers.dev subdomain. It's
 * the same code as for a missing Worker.
 */
const NO_ACCOUNT_SUBDOMAIN = 10007;

/** True for a Worker that doesn't exist. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(WORKER_NOT_FOUND);

// A Worker made without code, such as in the dashboard, has no versions.
const hasNoVersions = (error: CloudflareApiError): boolean =>
  error.status === 404 && error.hasMessage(/has no versions/i);

const scriptPath = (account: string, scriptName: string) =>
  `/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(scriptName)}`;

export const bindingSchema = v.variant("type", [
  v.object({
    type: v.literal("plain_text"),
    name: v.string(),
    text: v.string(),
  }),
  v.object({
    type: v.literal("durable_object_namespace"),
    name: v.string(),
    class_name: v.string(),
    /** The Worker that hosts the namespace, if it is another Worker. */
    script_name: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("service"),
    name: v.string(),
    service: v.string(),
  }),
  v.object({
    type: v.literal("secrets_store_secret"),
    name: v.string(),
    store_id: v.string(),
    secret_name: v.string(),
  }),
  v.object({
    type: v.literal("kv_namespace"),
    name: v.string(),
    namespace_id: v.string(),
  }),
]);

export type ScriptBinding = v.InferOutput<typeof bindingSchema>;

export type DurableObjectExport =
  | { type: "durable-object"; storage: "sqlite" }
  | { type: "durable-object"; state: "deleted" }
  | { type: "durable-object"; state: "renamed"; renamed_to: string }
  | {
      type: "durable-object";
      storage: "sqlite";
      state: "expecting-transfer";
      /** The Worker that hosts the namespace now. */
      transfer_from: string;
    }
  | { type: "durable-object"; state: "transferred"; transferred_to: string };

export type ScriptSettings = {
  compatibility_date?: string;
  compatibility_flags?: string[];
};

export type ScriptUpload = {
  /** The uploaded file name of the main module. */
  mainModule: string;
  code: Buffer;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: ScriptBinding[];
  exports: Record<string, DurableObjectExport>;
};

/**
 * Returns `undefined` if the Worker doesn't exist, and no settings for a
 * Worker with no versions.
 */
export async function getScriptSettings(
  account: string,
  scriptName: string,
): Promise<ScriptSettings | undefined> {
  try {
    return await cloudflare<ScriptSettings>(
      "GET",
      `${scriptPath(account, scriptName)}/settings`,
    );
  } catch (error) {
    // Checked first, so that a Worker with no versions is never read as
    // missing, whatever code Cloudflare sends with it.
    if (error instanceof CloudflareApiError && hasNoVersions(error)) return {};
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Creates the Worker, or replaces a Worker with the same name. */
export async function putScript(
  account: string,
  scriptName: string,
  upload: ScriptUpload,
): Promise<void> {
  const metadata = {
    main_module: upload.mainModule,
    compatibility_date: upload.compatibilityDate,
    compatibility_flags: upload.compatibilityFlags,
    bindings: upload.bindings,
    ...(Object.keys(upload.exports).length > 0
      ? { exports: upload.exports }
      : {}),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set(
    upload.mainModule,
    new File([upload.code], upload.mainModule, {
      type: "application/javascript+module",
    }),
  );
  await cloudflare("PUT", scriptPath(account, scriptName), form);
}

/**
 * Sets the Durable Object `exports` map of the Worker's deployed version,
 * without uploading its code. The map must list every namespace that the
 * Worker hosts.
 */
export async function patchScriptExports(
  account: string,
  scriptName: string,
  exports: Record<string, DurableObjectExport>,
): Promise<void> {
  const form = new FormData();
  form.set("settings", JSON.stringify({ exports }));
  await cloudflare(
    "PATCH",
    `${scriptPath(account, scriptName)}/settings`,
    form,
  );
}

/** A Durable Object namespace in the account. */
export type AccountNamespace = {
  /** The Worker that hosts the namespace. */
  script: string;
  className: string;
  sqlite: boolean;
};

const NAMESPACE_PAGE_SIZE = 1000;
const MAX_NAMESPACE_PAGES = 100;

/**
 * Lists the account's Durable Object namespaces, one page after another
 * until a page is empty. Leaves out the namespaces of Worker previews and of
 * Workers in dispatch namespaces.
 */
export async function listAccountNamespaces(
  account: string,
): Promise<AccountNamespace[]> {
  const namespaces: AccountNamespace[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_NAMESPACE_PAGES) {
      throw new Error(
        `Cloudflare listed more than ${MAX_NAMESPACE_PAGES} pages of Durable Object namespaces in the account ${account}, so deploy stopped listing them.`,
      );
    }
    const items = await cloudflare<
      {
        script?: string | null;
        class?: string | null;
        use_sqlite?: boolean | null;
        dispatch_namespace?: string | null;
        preview?: unknown;
      }[]
    >(
      "GET",
      `/accounts/${encodeURIComponent(account)}/workers/durable_objects/namespaces?page=${page}&per_page=${NAMESPACE_PAGE_SIZE}`,
    );
    for (const item of items ?? []) {
      if (!item.script || !item.class) continue;
      if (item.dispatch_namespace || item.preview) continue;
      namespaces.push({
        script: item.script,
        className: item.class,
        // The API marks the field optional. Without it, a namespace counts
        // as key-value, which a move refuses.
        sqlite: item.use_sqlite === true,
      });
    }
    // Cloudflare may return fewer items than asked for on a page that isn't
    // the last, so only an empty page ends the list.
    if (!items?.length) return namespaces;
  }
}

/**
 * Without `force`, Cloudflare refuses to delete a Worker that another Worker
 * refers to. With it, the Worker is deleted, and the bindings to it stay
 * broken until each Worker that holds one is uploaded again. This is so even
 * when a Worker with the same name is created again.
 */
export async function deleteScript(
  account: string,
  scriptName: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  await cloudflare(
    "DELETE",
    `${scriptPath(account, scriptName)}${force ? "?force=true" : ""}`,
  );
}

/**
 * Cloudflare's error codes for a delete that it refuses because another
 * Worker binds the Worker as a service, or binds a Durable Object namespace
 * that the Worker hosts.
 */
const REFERENCED_CODES = [10142, 10064];

export const isReferenced = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  REFERENCED_CODES.some((code) => error.hasCode(code));

type ScriptReference = { service: string };

export type ScriptReferences = {
  /**
   * The names of the other Workers that refer to the Worker: each binds it as
   * a service, binds a Durable Object namespace that it hosts, uses it as
   * the outbound Worker of a dispatch namespace, or sends it tail events.
   */
  workers: string[];
  /** True when a Pages project binds the Worker as a service. */
  pagesFunction: boolean;
};

/** The references that a forced delete of the Worker would break. */
export async function getScriptReferences(
  account: string,
  scriptName: string,
): Promise<ScriptReferences> {
  const [references, tails] = await Promise.all([
    cloudflare<{
      services?: { incoming?: ScriptReference[]; pages_function?: boolean };
      // Includes the Worker itself when it binds its own namespace.
      durable_objects?: ScriptReference[];
      dispatch_outbounds?: ScriptReference[];
    }>("GET", `${scriptPath(account, scriptName)}/references`),
    cloudflare<{ producer?: { script?: string; service?: string } }[]>(
      "GET",
      `/accounts/${encodeURIComponent(account)}/workers/tails/by-consumer/${encodeURIComponent(scriptName)}`,
    ),
  ]);
  const workers = [
    ...(references.services?.incoming ?? []),
    ...(references.durable_objects ?? []),
    ...(references.dispatch_outbounds ?? []),
  ].map((reference) => reference.service);
  for (const tail of tails ?? []) {
    const producer = tail.producer?.script ?? tail.producer?.service;
    if (producer) workers.push(producer);
  }
  return {
    workers: [...new Set(workers)].filter((name) => name !== scriptName).sort(),
    pagesFunction: references.services?.pages_function === true,
  };
}

/**
 * Returns `undefined` if the Worker doesn't exist. `enabled` is true if the
 * Worker is served on workers.dev.
 */
export async function getScriptSubdomain(
  account: string,
  scriptName: string,
): Promise<{ enabled: boolean } | undefined> {
  try {
    return await cloudflare<{ enabled: boolean }>(
      "GET",
      `${scriptPath(account, scriptName)}/subdomain`,
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

// Without `previews_enabled`, enabling also turns on preview URLs, even for a
// Worker that had them off.
export async function setScriptSubdomain(
  account: string,
  scriptName: string,
  enabled: boolean,
): Promise<void> {
  await cloudflare("POST", `${scriptPath(account, scriptName)}/subdomain`, {
    enabled,
  });
}

/** Returns the account's workers.dev subdomain. */
export async function getAccountSubdomain(account: string): Promise<string> {
  try {
    const { subdomain } = await cloudflare<{ subdomain: string }>(
      "GET",
      `/accounts/${encodeURIComponent(account)}/workers/subdomain`,
    );
    return subdomain;
  } catch (error) {
    if (
      error instanceof CloudflareApiError &&
      error.hasCode(NO_ACCOUNT_SUBDOMAIN)
    ) {
      throw new Error(
        `The account ${account} has no workers.dev subdomain. Set one up at https://dash.cloudflare.com/${account}/workers/onboarding, then deploy again.`,
        { cause: error },
      );
    }
    throw error;
  }
}
