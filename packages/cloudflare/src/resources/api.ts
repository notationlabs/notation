import {
  ResourceCreationUnknownError,
  ResourceOperationPendingError,
} from "@notation/resource";

const API_URL = "https://api.cloudflare.com/client/v4";

/** Cloudflare's error code for a Worker that doesn't exist. */
const WORKER_NOT_FOUND = 10007;

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

export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  (error.status === 404 || error.hasCode(WORKER_NOT_FOUND));

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

/**
 * Returns the response's `result`. Throws `ResourceOperationPendingError`
 * on a 429, so the reconciler retries.
 */
export async function cloudflare<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  /** The path after `/client/v4`, such as `/accounts/<id>/workers/scripts`. */
  path: string,
  body?: FormData | object,
): Promise<T> {
  const request = `${method} ${path}`;
  const headers: Record<string, string> = {
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
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
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
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ResourceOperationPendingError(
      `Cloudflare API ${request} is rate limited`,
      {
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1_000
            : 5_000,
      },
    );
  }
  let envelope: Envelope<T> = {};
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    // The response is not JSON, such as an HTML error page. The error then
    // has only the status.
  }
  if (!response.ok || envelope.success === false) {
    throw new CloudflareApiError(
      request,
      response.status,
      envelope.errors ?? [],
    );
  }
  return envelope.result as T;
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

export const scriptPath = (account: string, scriptName: string) =>
  `/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(scriptName)}`;
