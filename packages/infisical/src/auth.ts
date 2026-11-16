import { apiUrl, request } from "./api";

type LoginResponse = { accessToken: string; expiresIn?: number };

const logins = new Map<string, { token: Promise<string>; expiresAt: number }>();

/**
 * Returns an access token as `accessToken` does, and keeps a token from a
 * login for half of its lifetime, so that the sources of one process log in
 * once.
 */
export function cachedAccessToken(site: string): Promise<string> {
  const env = process.env;
  if (env.INFISICAL_TOKEN) return Promise.resolve(env.INFISICAL_TOKEN);
  const key = JSON.stringify([
    site,
    env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID,
    env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET,
    env.INFISICAL_IDENTITY_ID,
    env.INFISICAL_JWT,
  ]);
  const cached = logins.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  // Until the login returns, its lifetime is unknown. Calls in that time
  // share the request.
  const entry = { token: Promise.resolve(""), expiresAt: Infinity };
  entry.token = login(site).then(
    (response) => {
      entry.expiresAt = Date.now() + ((response.expiresIn ?? 0) * 1000) / 2;
      return response.accessToken;
    },
    (error) => {
      logins.delete(key);
      throw error;
    },
  );
  logins.set(key, entry);
  return entry.token;
}

/**
 * Returns an Infisical access token. It takes the first of:
 *
 * 1. `INFISICAL_TOKEN`, an access token.
 * 2. `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and
 *    `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`, a machine identity's client ID
 *    and secret, exchanged through universal auth.
 * 3. `INFISICAL_IDENTITY_ID`, a machine identity that uses OIDC auth, with
 *    the CI platform's OIDC token. See `oidcToken`.
 */
export async function accessToken(site: string): Promise<string> {
  return (await login(site)).accessToken;
}

async function login(site: string): Promise<LoginResponse> {
  const env = process.env;
  if (env.INFISICAL_TOKEN) return { accessToken: env.INFISICAL_TOKEN };

  const clientId = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID;
  const clientSecret = env.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET;
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      throw new Error(
        "Set both INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET to log in to Infisical with a machine identity.",
      );
    }
    return request<LoginResponse>(
      "POST",
      apiUrl(site, "/api/v1/auth/universal-auth/login"),
      { body: { clientId, clientSecret } },
    );
  }

  const identityId = env.INFISICAL_IDENTITY_ID;
  if (identityId) {
    return request<LoginResponse>(
      "POST",
      apiUrl(site, "/api/v1/auth/oidc-auth/login"),
      { body: { identityId, jwt: await oidcToken() } },
    );
  }

  throw new Error(
    "Set INFISICAL_TOKEN, or INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, or INFISICAL_IDENTITY_ID in CI, to read secrets from Infisical.",
  );
}

/**
 * Returns the CI platform's OIDC token: `INFISICAL_JWT` if it is set, and
 * otherwise a token requested from GitHub Actions. A platform that puts its
 * token in a variable, such as GitLab's `id_tokens`, can name it
 * `INFISICAL_JWT`.
 */
async function oidcToken(): Promise<string> {
  const env = process.env;
  if (env.INFISICAL_JWT) return env.INFISICAL_JWT;

  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url && token) {
    const tokenUrl = new URL(url);
    // Without an audience, GitHub sets `aud` to the URL of the repository
    // owner, which is what Infisical's GitHub guide configures.
    if (env.INFISICAL_OIDC_AUDIENCE) {
      tokenUrl.searchParams.set("audience", env.INFISICAL_OIDC_AUDIENCE);
    }
    const response = await request<{ value: string }>("GET", tokenUrl, {
      token,
    });
    return response.value;
  }

  throw new Error(
    "INFISICAL_IDENTITY_ID is set, but there is no OIDC token to log in with. In GitHub Actions, give the job the permission `id-token: write`. On another CI platform, set INFISICAL_JWT to its OIDC token.",
  );
}
