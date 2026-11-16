import { apiUrl, InfisicalApiError, request, siteUrl } from "../api";
import { cachedAccessToken } from "../auth";

export type SecretAddress = {
  projectId: string;
  environment: string;
  path: string;
  key: string;
};

export type FetchedSecret = {
  id: string;
  version: number;
  secretKey: string;
  secretValue: string;
  secretValueHidden?: boolean;
};

export function where(address: SecretAddress): string {
  return `Infisical project ${address.projectId}, environment ${address.environment}, path ${normalisePath(address.path)}`;
}

/**
 * Fetches one shared secret, with `GET /api/v4/secrets/{secretName}`. Without
 * `version`, it fetches the current version. Secrets imported into the
 * folder are not found.
 */
export async function getSecret(
  address: SecretAddress,
  options: { expandSecretReferences: boolean; version?: number },
): Promise<FetchedSecret> {
  const site = siteUrl();
  const token = await cachedAccessToken(site);
  const url = apiUrl(
    site,
    `/api/v4/secrets/${encodeURIComponent(address.key)}`,
  );
  const query = new URLSearchParams({
    projectId: address.projectId,
    environment: address.environment,
    secretPath: normalisePath(address.path),
    // A personal override belongs to one user, and must never be written
    // to a shared store.
    type: "shared",
    viewSecretValue: "true",
    expandSecretReferences: String(options.expandSecretReferences),
    includeImports: "false",
  });
  if (options.version !== undefined) {
    query.set("version", String(options.version));
  }
  url.search = query.toString();
  let secret: FetchedSecret;
  try {
    ({ secret } = await request<{ secret: FetchedSecret }>("GET", url, {
      token,
    }));
  } catch (error) {
    if (error instanceof InfisicalApiError && error.status === 404) {
      const subject =
        options.version === undefined
          ? `\`${address.key}\``
          : `Version ${options.version} of \`${address.key}\``;
      throw new Error(`${subject} isn't in ${where(address)}.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (secret.secretValueHidden) {
    throw new Error(
      `The Infisical identity can't read the value of \`${address.key}\` in ${where(address)}. Give it a role that can read secret values.`,
    );
  }
  return secret;
}

function normalisePath(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, "")}`;
}
