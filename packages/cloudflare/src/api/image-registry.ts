import { cloudflare } from "./client";

/** The hostname of the account's Cloudflare registry. */
export const CLOUDFLARE_REGISTRY = "registry.cloudflare.com";

const REQUEST_TIMEOUT_MS = 30_000;

// The manifest types that `docker push` can make, so that the registry
// returns the digest of the manifest as it was pushed.
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

export type RegistryCredentials = { username: string; password: string };

/**
 * Returns the account's namespace in the Cloudflare registry. Wrangler pushes
 * to `registry.cloudflare.com/<external_account_id>/<repository>`.
 */
export async function registryNamespace(account: string): Promise<string> {
  const me = await cloudflare<{ external_account_id: string }>(
    "GET",
    `/accounts/${encodeURIComponent(account)}/containers/me`,
  );
  return me.external_account_id;
}

/**
 * Makes credentials for the account's Cloudflare registry, which expire
 * after 15 minutes.
 */
export async function registryCredentials(
  account: string,
  permissions: ("push" | "pull")[],
): Promise<RegistryCredentials> {
  return await cloudflare<RegistryCredentials>(
    "POST",
    `/accounts/${encodeURIComponent(account)}/containers/registries/${CLOUDFLARE_REGISTRY}/credentials`,
    { expiration_minutes: 15, permissions },
  );
}

/**
 * Returns the digest of the manifest that `reference`, a tag or a digest,
 * names in `namespace/repository`, or `undefined` if the registry has no
 * such manifest.
 */
export async function manifestDigest(
  credentials: RegistryCredentials,
  namespace: string,
  repository: string,
  reference: string,
): Promise<string | undefined> {
  const url = `https://${CLOUDFLARE_REGISTRY}/v2/${namespace}/${repository}/manifests/${reference}`;
  const response = await fetch(url, {
    method: "HEAD",
    headers: {
      // Wrangler sends the username `v1` on registry HTTP requests, and the
      // returned username only to `docker login`. This follows Wrangler.
      Authorization: `Basic ${Buffer.from(`v1:${credentials.password}`).toString("base64")}`,
      Accept: MANIFEST_TYPES,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`HEAD ${url} failed with status ${response.status}`);
  }
  const digest = response.headers.get("Docker-Content-Digest");
  if (!digest) {
    throw new Error(`HEAD ${url} returned no Docker-Content-Digest header`);
  }
  return digest;
}
