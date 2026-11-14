export const DEFAULT_SITE_URL = "https://app.infisical.com";

const REQUEST_TIMEOUT_MS = 30_000;

export class InfisicalApiError extends Error {
  readonly status: number;

  constructor(request: string, status: number, message: string | undefined) {
    super(
      `Infisical API ${request} failed with status ${status}${message ? `: ${message}` : ""}`,
    );
    this.name = "InfisicalApiError";
    this.status = status;
  }
}

/**
 * Returns the URL of the Infisical instance: the `siteUrl` option, then
 * `INFISICAL_DOMAIN`, then Infisical Cloud. A trailing `/api` is dropped, as
 * Infisical's CLI has taken the instance URL both with and without it.
 */
export function siteUrl(option: string | undefined): string {
  const url = option ?? process.env.INFISICAL_DOMAIN ?? DEFAULT_SITE_URL;
  return url.replace(/\/+$/, "").replace(/\/api$/, "");
}

/**
 * The URL of an API path on the instance at `site`. A path prefix of the
 * site, such as `/infisical`, is kept.
 */
export function apiUrl(site: string, path: string): URL {
  return new URL(`${site}${path}`);
}

export async function request<T>(
  method: "GET" | "POST",
  url: URL,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  const label = `${method} ${url.pathname}`;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Infisical API ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new InfisicalApiError(
      label,
      response.status,
      await errorMessage(response),
    );
  }
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch {}
  return text.trim() || undefined;
}
