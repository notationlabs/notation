import {
  ResourceCreationUnknownError,
  ResourceOperationPendingError,
} from "@notation/resource";

const API_URL = "https://api.cloudflare.com/client/v4";

// Some errors have no code, such as a 403 for a token without access.
export type CloudflareErrorItem = { code?: number; message: string };

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CloudflareErrorItem[];

  constructor(
    request: string,
    status: number,
    errors: CloudflareErrorItem[],
    options?: ErrorOptions,
  ) {
    const details = errors
      .map((e) =>
        e.code === undefined ? e.message : `${e.message} (${e.code})`,
      )
      .join("; ");
    super(
      `Cloudflare API ${request} failed with status ${status}${details ? `: ${details}` : ""}`,
      options,
    );
    this.name = "CloudflareApiError";
    this.status = status;
    this.errors = errors;
  }

  hasCode(code: number): boolean {
    return this.errors.some((error) => error.code === code);
  }

  hasMessage(pattern: RegExp): boolean {
    return this.errors.some((error) => pattern.test(error.message));
  }
}

// Long enough to upload a Worker at Cloudflare's size limit.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The request failed on the network or timed out. It may still have reached
 * Cloudflare.
 */
export class CloudflareNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudflareNetworkError";
  }
}

/**
 * Reads `CLOUDFLARE_ACCOUNT_ID`. Each resource stores the id in state, so an
 * update or a delete uses the account that the resource was created in.
 */
export function accountId(): string {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) {
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID to the ID of the Cloudflare account to deploy to. The dashboard shows it on the account's Workers & Pages page.",
    );
  }
  return id;
}

function apiToken(): string {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN to an API token with the Workers Scripts: Edit permission for the account.",
    );
  }
  return token;
}

type Envelope<T> = {
  success?: boolean;
  errors?: CloudflareErrorItem[];
  result?: T;
};

// Cloudflare's code for "Please wait and consider throttling your request
// speed".
const THROTTLED = 971;

// Cloudflare can report a rate limit with another status than 429, even 200.
function isRateLimited(errors: CloudflareErrorItem[]): boolean {
  return errors.some(
    (error) =>
      error.code === THROTTLED ||
      /\b(rate ?limit(ed|ing)?|throttl(ed|ing) your request)\b/i.test(
        error.message,
      ),
  );
}

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

/**
 * Returns the response's `result`. Throws a throttled
 * `ResourceOperationPendingError` when the request is rate limited, so the
 * reconciler retries.
 */
export async function cloudflare<T>(
  method: Method,
  /** The path after `/client/v4`, such as `/accounts/<id>/workers/scripts`. */
  path: string,
  body?: FormData | object,
  requestHeaders: Record<string, string> = {},
): Promise<T> {
  const { request, response, text } = await send(
    method,
    path,
    body,
    requestHeaders,
  );
  const envelope = parseEnvelope<T>(text);
  checkResponse(request, response, envelope);
  return envelope.result as T;
}

/**
 * Sends a GET and returns the response body as text, for an endpoint whose
 * success response is not a JSON envelope, such as a read of a KV value. An
 * error response is an envelope, and throws as in `cloudflare`.
 */
export async function cloudflareGetText(
  /** The path after `/client/v4`. */
  path: string,
): Promise<string> {
  const { request, response, text } = await send("GET", path);
  // A success body is the stored value, which can itself look like an
  // envelope, so it is parsed only for an error status.
  checkResponse(request, response, response.ok ? {} : parseEnvelope(text));
  return text;
}

// `Response.text()` strips a leading U+FEFF, which would change a KV value
// that starts with one.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

async function send(
  method: Method,
  path: string,
  body?: FormData | object,
  requestHeaders: Record<string, string> = {},
): Promise<{ request: string; response: Response; text: string }> {
  const request = `${method} ${path}`;
  const headers: Record<string, string> = {
    ...requestHeaders,
    Authorization: `Bearer ${apiToken()}`,
  };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  // The timeout also covers reading the body, so the body is read inside
  // the try.
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = await response.arrayBuffer();
    return { request, response, text: utf8.decode(bytes) };
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new CloudflareNetworkError(
        `Cloudflare API ${request} got no response within ${REQUEST_TIMEOUT_MS / 1_000} seconds`,
        { cause: error },
      );
    }
    if (error instanceof TypeError) {
      throw new CloudflareNetworkError(
        `Cloudflare API ${request} failed on the network: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function parseEnvelope<T>(text: string): Envelope<T> {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // The response is not JSON, such as an HTML error page. The error then
    // has only the status.
    return {};
  }
}

function checkResponse(
  request: string,
  response: Response,
  envelope: Envelope<unknown>,
): void {
  const errors = envelope.errors ?? [];
  const failed = !response.ok || envelope.success === false;
  if (response.status === 429 || (failed && isRateLimited(errors))) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ResourceOperationPendingError(
      `Cloudflare API ${request} is rate limited`,
      {
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : 5_000,
        throttled: true,
      },
    );
  }
  if (failed) {
    throw new CloudflareApiError(request, response.status, errors);
  }
}

/**
 * True for a network failure, a timeout or a server error. In each case the
 * request may have reached Cloudflare.
 */
function callMayHaveTakenEffect(error: unknown): boolean {
  if (error instanceof CloudflareApiError) return error.status >= 500;
  return error instanceof CloudflareNetworkError;
}

/**
 * Wraps a `create` so that it throws `ResourceCreationUnknownError` when the
 * call may have taken effect.
 */
export function cloudflareCreate<Args extends unknown[], Result>(
  create: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await create(...args);
    } catch (error) {
      if (!callMayHaveTakenEffect(error)) throw error;
      throw new ResourceCreationUnknownError(
        `Cloudflare did not report whether the resource was created: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
}
