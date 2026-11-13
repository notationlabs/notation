import { createHash } from "node:crypto";
import { getExecutionContext, Redacted } from "@notation/core";
import type { Source, SourceContext } from "@notation/std/sources";

const DEFAULT_SITE_URL = "https://app.infisical.com";
const TOKEN_EXPIRY_BUFFER_MS = 30_000;

/**
 * Standard CI environment variables that hold an OIDC JWT directly.
 */
const OIDC_TOKEN_ENV_VARS = [
  "INFISICAL_OIDC_TOKEN",
  "CI_JOB_JWT_V2",
  "CI_JOB_JWT",
  "BUILDKITE_OIDC_TOKEN",
  "CIRCLE_OIDC_TOKEN",
  "CIRCLE_OIDC_TOKEN_V2",
  "BITBUCKET_STEP_OIDC_TOKEN",
] as const;

export type InfisicalOptions = {
  /** Infisical project ID (`workspaceId` in the v3 secrets API). */
  projectId: string;
  /** Infisical environment slug, or a function mapping the Notation stage to one. */
  environment: string | ((stage: string) => string);
  /** Folder path within the environment. Defaults to `"/"`. */
  path?: string;
  /**
   * Infisical API base URL. Defaults to `process.env.INFISICAL_API_URL` or
   * `"https://app.infisical.com"`.
   */
  siteUrl?: string;
};

type SecretRecord = {
  value: string;
  version: string | undefined;
};

type TokenResponse = {
  accessToken?: unknown;
  expiresIn?: unknown;
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

const folderCache = new Map<string, Promise<Map<string, SecretRecord>>>();
const tokenCache = new Map<string, Promise<CachedToken>>();

/**
 * Clears in-process cached Infisical folder responses and auth tokens.
 * Intended for test isolation.
 */
export function clearInfisicalCache(): void {
  folderCache.clear();
  tokenCache.clear();
}

function resolveSiteUrl(siteUrl?: string): string {
  const raw = siteUrl || process.env.INFISICAL_API_URL || DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, "");
}

function normalizeSecretPath(secretPath?: string): string {
  if (!secretPath || secretPath === "/") {
    return "/";
  }
  const withLeading = secretPath.startsWith("/")
    ? secretPath
    : `/${secretPath}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveEnvironment(
  environment: InfisicalOptions["environment"],
  context: SourceContext,
): string {
  const resolved =
    typeof environment === "function" ? environment(context.stage) : environment;
  if (!resolved) {
    throw new Error(
      `Infisical environment resolved to an empty string for stage "${context.stage}".`,
    );
  }
  return resolved;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function postJson<T>(
  url: string,
  body: Record<string, string>,
  label: string,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `${label} failed (${response.status} ${response.statusText}): ${detail}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchGitHubOidcToken(): Promise<string | undefined> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    return undefined;
  }

  const url = new URL(requestUrl);
  const audience = process.env.INFISICAL_OIDC_AUDIENCE;
  if (audience) {
    url.searchParams.set("audience", audience);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Failed to fetch GitHub Actions OIDC token (${response.status} ${response.statusText}): ${detail}`,
    );
  }

  const data = (await response.json()) as { value?: unknown };
  if (typeof data?.value !== "string" || !data.value) {
    throw new Error(
      "GitHub Actions OIDC token response did not include a valid token value.",
    );
  }

  return data.value;
}

async function resolveOidcJwt(): Promise<string> {
  for (const envVar of OIDC_TOKEN_ENV_VARS) {
    const token = process.env[envVar];
    if (token) {
      return token;
    }
  }

  const githubToken = await fetchGitHubOidcToken();
  if (githubToken) {
    return githubToken;
  }

  throw new Error(
    "Infisical OIDC auth is configured with INFISICAL_IDENTITY_ID, but no CI OIDC token was found in the environment (checked INFISICAL_OIDC_TOKEN, CI_JOB_JWT_V2, CI_JOB_JWT, BUILDKITE_OIDC_TOKEN, CIRCLE_OIDC_TOKEN, CIRCLE_OIDC_TOKEN_V2, BITBUCKET_STEP_OIDC_TOKEN, and GitHub Actions ACTIONS_ID_TOKEN_REQUEST_URL/ACTIONS_ID_TOKEN_REQUEST_TOKEN).",
  );
}

async function getCachedToken(
  cacheKey: string,
  loader: () => Promise<TokenResponse>,
  label: string,
): Promise<string> {
  const existing = tokenCache.get(cacheKey);
  if (existing) {
    try {
      const cached = await existing;
      if (Date.now() < cached.expiresAt) {
        return cached.token;
      }
    } catch {
      // Fall through to re-fetch if the cached promise rejected.
    }
    if (tokenCache.get(cacheKey) === existing) {
      tokenCache.delete(cacheKey);
    } else {
      const replacement = tokenCache.get(cacheKey);
      if (replacement) {
        const cached = await replacement;
        return cached.token;
      }
    }
  }

  const promise = loader().then((data) => {
    if (typeof data?.accessToken !== "string" || !data.accessToken) {
      throw new Error(`${label} response did not include an accessToken.`);
    }
    const expiresInSeconds =
      typeof data.expiresIn === "number" && data.expiresIn > 0
        ? data.expiresIn
        : 3600;
    return {
      token: data.accessToken,
      expiresAt: Date.now() + expiresInSeconds * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };
  });

  tokenCache.set(cacheKey, promise);

  try {
    const result = await promise;
    return result.token;
  } catch (error) {
    if (tokenCache.get(cacheKey) === promise) {
      tokenCache.delete(cacheKey);
    }
    throw error;
  }
}

type ResolvedAuth = {
  fingerprint: string;
  getToken: () => Promise<string>;
};

function resolveAuth(siteUrl: string): ResolvedAuth {
  const directToken = process.env.INFISICAL_TOKEN;
  if (directToken) {
    return {
      fingerprint: sha256(`token\0${directToken}`),
      getToken: async () => directToken,
    };
  }

  const clientId = process.env.INFISICAL_CLIENT_ID;
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error(
        "Infisical Universal Auth requires both INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET.",
      );
    }

    const fingerprint = sha256(`universal-auth\0${clientId}\0${clientSecret}`);
    const cacheKey = `${siteUrl}\0${fingerprint}`;
    return {
      fingerprint,
      getToken: () =>
        getCachedToken(
          cacheKey,
          () =>
            postJson<TokenResponse>(
              `${siteUrl}/api/v1/auth/universal-auth/login`,
              { clientId, clientSecret },
              "Infisical Universal Auth login",
            ),
          "Infisical Universal Auth login",
        ),
    };
  }

  const identityId = process.env.INFISICAL_IDENTITY_ID;
  if (identityId) {
    const envOidcToken =
      OIDC_TOKEN_ENV_VARS.map((envVar) => process.env[envVar]).find(Boolean) ??
      "";
    const ghUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
    const ghToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
    const audience = process.env.INFISICAL_OIDC_AUDIENCE ?? "";
    const fingerprint = sha256(
      `oidc-auth\0${identityId}\0${envOidcToken}\0${ghUrl}\0${ghToken}\0${audience}`,
    );
    const cacheKey = `${siteUrl}\0${fingerprint}`;
    return {
      fingerprint,
      getToken: () =>
        getCachedToken(
          cacheKey,
          async () => {
            const jwt = await resolveOidcJwt();
            return postJson<TokenResponse>(
              `${siteUrl}/api/v1/auth/oidc-auth/login`,
              { identityId, jwt },
              "Infisical OIDC Auth login",
            );
          },
          "Infisical OIDC Auth login",
        ),
    };
  }

  throw new Error(
    "Infisical authentication is not configured. Set INFISICAL_TOKEN, INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET, or INFISICAL_IDENTITY_ID with a CI OIDC token.",
  );
}

async function fetchFolderSecrets(
  siteUrl: string,
  projectId: string,
  environment: string,
  secretPath: string,
  getToken: () => Promise<string>,
): Promise<Map<string, SecretRecord>> {
  const accessToken = await getToken();

  const url = new URL(`${siteUrl}/api/v3/secrets/raw`);
  url.searchParams.set("workspaceId", projectId);
  url.searchParams.set("environment", environment);
  url.searchParams.set("secretPath", secretPath);
  url.searchParams.set("recursive", "false");
  url.searchParams.set("expandSecretReferences", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(
      `Infisical secrets fetch failed (${response.status} ${response.statusText}): ${detail}`,
    );
  }

  const data = (await response.json()) as { secrets?: unknown };
  if (!Array.isArray(data?.secrets)) {
    throw new Error(
      "Infisical secrets response did not include a secrets array.",
    );
  }

  const entries = new Map<string, SecretRecord>();
  for (const item of data.secrets) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { secretKey?: unknown }).secretKey === "string" &&
      typeof (item as { secretValue?: unknown }).secretValue === "string"
    ) {
      const secret = item as {
        secretKey: string;
        secretValue: string;
        version?: unknown;
      };
      const version =
        typeof secret.version === "number" || typeof secret.version === "string"
          ? String(secret.version)
          : undefined;
      entries.set(secret.secretKey, { value: secret.secretValue, version });
    }
  }

  return entries;
}

async function loadFolder(
  siteUrl: string,
  projectId: string,
  environment: string,
  secretPath: string,
): Promise<Map<string, SecretRecord>> {
  const auth = resolveAuth(siteUrl);
  const executionId = getExecutionContext()?.executionId;
  const executionScope =
    executionId !== undefined ? `exec:${executionId}` : "process";
  const cacheKey = `${executionScope}\0${auth.fingerprint}\0${siteUrl}\0${projectId}\0${environment}\0${secretPath}`;
  const cached = folderCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = fetchFolderSecrets(
    siteUrl,
    projectId,
    environment,
    secretPath,
    auth.getToken,
  ).catch((error) => {
    if (folderCache.get(cacheKey) === promise) {
      folderCache.delete(cacheKey);
    }
    throw error;
  });

  folderCache.set(cacheKey, promise);
  return promise;
}

function requireSecret(
  entries: Map<string, SecretRecord>,
  key: string,
  projectId: string,
  environment: string,
  secretPath: string,
): SecretRecord {
  const entry = entries.get(key);
  if (!entry) {
    throw new Error(
      `Secret "${key}" was not found in Infisical (project "${projectId}", environment "${environment}", path "${secretPath}").`,
    );
  }
  return entry;
}

/**
 * Secret source backed by a single Infisical folder. Fetches and caches the
 * folder once per `(siteUrl, projectId, environment, path)` in the current
 * process, and returns each secret's Infisical version for change detection.
 */
export function infisical(options: InfisicalOptions): Source {
  if (!options.projectId) {
    throw new Error("Infisical source requires a non-empty projectId.");
  }

  const secretPath = normalizeSecretPath(options.path);

  const loadForContext = async (context: SourceContext) => {
    const siteUrl = resolveSiteUrl(options.siteUrl);
    const environment = resolveEnvironment(options.environment, context);
    const entries = await loadFolder(
      siteUrl,
      options.projectId,
      environment,
      secretPath,
    );
    return { entries, environment };
  };

  return {
    name: "infisical",
    async has(key, context) {
      const { entries } = await loadForContext(context);
      return entries.has(key);
    },
    async version(key, context) {
      const { entries, environment } = await loadForContext(context);
      const entry = requireSecret(
        entries,
        key,
        options.projectId,
        environment,
        secretPath,
      );
      if (entry.version === undefined) {
        throw new Error(
          `Secret "${key}" in Infisical (project "${options.projectId}", environment "${environment}", path "${secretPath}") did not include a version.`,
        );
      }
      return entry.version;
    },
    async get(key, context) {
      const { entries, environment } = await loadForContext(context);
      const entry = requireSecret(
        entries,
        key,
        options.projectId,
        environment,
        secretPath,
      );
      return new Redacted(entry.value);
    },
  };
}
