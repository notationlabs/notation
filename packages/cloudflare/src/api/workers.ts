import * as v from "valibot";
import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a Worker that doesn't exist. */
const WORKER_NOT_FOUND = 10007;

/**
 * True for a Worker or a workers.dev setting that doesn't exist. Cloudflare
 * also returns a 404 for a Worker with no versions, but that Worker exists.
 */
export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  (error.hasCode(WORKER_NOT_FOUND) ||
    (error.status === 404 && !hasNoVersions(error)));

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
]);

export type ScriptBinding = v.InferOutput<typeof bindingSchema>;

export type DurableObjectExport =
  | { type: "durable-object"; storage: "sqlite" }
  | { type: "durable-object"; state: "deleted" }
  | { type: "durable-object"; state: "renamed"; renamed_to: string };

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
    if (isNotFound(error)) return undefined;
    if (error instanceof CloudflareApiError && hasNoVersions(error)) return {};
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

export async function deleteScript(
  account: string,
  scriptName: string,
): Promise<void> {
  await cloudflare("DELETE", scriptPath(account, scriptName));
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

// `previews_enabled` is omitted, so the preview URL setting from the
// dashboard is kept.
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
  const { subdomain } = await cloudflare<{ subdomain: string }>(
    "GET",
    `/accounts/${encodeURIComponent(account)}/workers/subdomain`,
  );
  return subdomain;
}
