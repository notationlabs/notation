import { execFileSync } from "node:child_process";
import { api } from "../../e2e";

// The linux/amd64 image of traefik/whoami v1.11.0, which serves its hostname
// and the request's headers on port 80. A build that adds a file to it gives
// a new digest for each version of the file.
export const BASE_IMAGE =
  "docker.io/traefik/whoami@sha256:4f90b33ddca9c4d4f06527070d6e503b16d71016edea036842be2a84e60c91cb";

export const REGISTRY = "registry.cloudflare.com";

// Checked only with credentials, so that a run without them doesn't wait
// for `docker info`.
export function dockerIsRunning(): boolean {
  if (!process.env.CLOUDFLARE_API_TOKEN) return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export type Application = {
  id: string;
  name: string;
  configuration: { image: string };
  durable_objects?: { namespace_id: string };
  active_rollout_id?: string;
};

export async function applicationsWithPrefix(
  prefix: string,
): Promise<Application[]> {
  const response = await api<Application[] | null>(
    "GET",
    "/containers/applications",
  );
  if (!response.success) {
    throw new Error(
      `Listing container applications failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return (response.result ?? []).filter((application) =>
    application.name.startsWith(prefix),
  );
}

export async function deleteApplicationsWithPrefix(
  prefix: string,
): Promise<void> {
  for (const application of await applicationsWithPrefix(prefix)) {
    await api("DELETE", `/containers/applications/${application.id}`);
  }
}

export async function waitForRollout(
  applicationId: string,
): Promise<Application> {
  const deadline = Date.now() + 480_000;
  for (;;) {
    const response = await api<Application>(
      "GET",
      `/containers/applications/${applicationId}`,
    );
    if (response.success && !response.result.active_rollout_id) {
      return response.result;
    }
    if (Date.now() > deadline) {
      throw new Error(`The rollout of ${applicationId} didn't end in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

/** The account's namespace in the registry. */
export async function registryNamespace(): Promise<string> {
  const response = await api<{ external_account_id: string }>(
    "GET",
    "/containers/me",
  );
  if (!response.success) {
    throw new Error(
      `Reading the Containers account failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result.external_account_id;
}

// The value of a Basic Authorization header for the registry, as Wrangler
// sends it.
async function registryAuth(): Promise<string> {
  const response = await api<{ password: string }>(
    "POST",
    `/containers/registries/${REGISTRY}/credentials`,
    { expiration_minutes: 5, permissions: ["pull", "push"] },
  );
  if (!response.success) {
    throw new Error(
      `Making registry credentials failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return `Basic ${Buffer.from(`v1:${response.result.password}`).toString("base64")}`;
}

// The registry also lists the digest of each manifest, such as
// `sha256:...`, among the tags. They are left out.
export async function repositoryTags(repository: string): Promise<string[]> {
  const response = await fetch(
    `https://${REGISTRY}/v2/${await registryNamespace()}/${repository}/tags/list`,
    { headers: { Authorization: await registryAuth() } },
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Listing the tags failed with ${response.status}`);
  }
  const tags =
    ((await response.json()) as { tags?: string[] | null }).tags ?? [];
  return tags.filter((tag) => !tag.startsWith("sha256:"));
}

// Deletes each tag of the repository, as `wrangler containers images delete`
// does, since ContainerImage's delete leaves images in the registry.
export async function deleteRepository(repository: string): Promise<void> {
  const base = `https://${REGISTRY}/v2/${await registryNamespace()}/${repository}`;
  const auth = await registryAuth();
  for (const tag of await repositoryTags(repository)) {
    const response = await fetch(`${base}/manifests/${tag}`, {
      method: "DELETE",
      headers: {
        Authorization: auth,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Deleting ${repository}:${tag} failed with ${response.status}`,
      );
    }
  }
  await fetch(`https://${REGISTRY}/v2/gc/layers`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
  }).catch(() => undefined);
}
