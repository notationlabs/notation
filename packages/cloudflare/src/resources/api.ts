import {
  ResourceCreationUnknownError,
  ResourceOperationPendingError,
} from "@notation/resource";

const API_URL = "https://api.cloudflare.com/client/v4";

/** The code of Cloudflare's error for a Worker that doesn't exist. */
const WORKER_NOT_FOUND = 10007;

export type CloudflareErrorItem = { code: number; message: string };

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly errors: CloudflareErrorItem[];

  constructor(
    request: string,
    status: number,
    errors: CloudflareErrorItem[],
    options?: ErrorOptions,
  ) {
    const details = errors.map((e) => `${e.message} (${e.code})`).join("; ");
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

// Long enough for the upload of a Worker at Cloudflare's size limit.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * A Cloudflare call that failed on the network, or got no whole response
 * within the timeout. The request may have reached Cloudflare.
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
 * The account that resources are deployed to, from `CLOUDFLARE_ACCOUNT_ID`.
 * It is read when params are derived, and stored in state, so a resource
 * that is later updated or deleted uses the account it was made in.
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
 * Calls the Cloudflare API and returns `result` from the response.
 * Cloudflare's rate limit, status 429, is thrown as
 * `ResourceOperationPendingError`, so the reconciler waits and tries again.
 * @param path The path after `/client/v4`, such as `/accounts/<id>/workers/scripts`.
 */
export async function cloudflare<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
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
  // The timeout also applies to reading the body, so the body is read in
  // the same try. fetch throws a TypeError when the network fails.
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
    // A response that is not JSON, such as an HTML error page, has no
    // error items. The status is reported alone.
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
 * Returns true when a Cloudflare call may have taken effect without a
 * response reaching the caller: the request failed on the network or timed
 * out, or the API answered with a server error.
 */
function callMayHaveTakenEffect(error: unknown): boolean {
  if (error instanceof CloudflareApiError) return error.status >= 500;
  return error instanceof CloudflareNetworkError;
}

/**
 * Wraps a `create` so that an error from a call that may have taken effect
 * is thrown as `ResourceCreationUnknownError`.
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
