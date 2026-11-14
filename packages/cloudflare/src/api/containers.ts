import * as v from "valibot";
import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a container application that doesn't exist. */
const APPLICATION_NOT_FOUND = 1609;

/** Cloudflare's error code for a namespace whose class is not a container class. */
export const NAMESPACE_NOT_CONTAINER_ENABLED = 1607;

/** Cloudflare's error code for a namespace that already has an application. */
export const NAMESPACE_HAS_APPLICATION = 1608;

export const isApplicationNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(APPLICATION_NOT_FOUND);

const assignIpSchema = v.picklist(["none", "predefined"]);

// Cloudflare rejects a configuration with a key it doesn't know, so the
// object is strict and a misspelt key fails before the request.
export const configurationSchema = v.pipe(
  v.strictObject({
    /**
     * Pin the image by its digest, such as `registry.cloudflare.com/<account>/app@sha256:...`.
     * A rollout starts only when `Configuration` changes, so pushing a new image
     * under the same tag starts no rollout.
     */
    image: v.string(),
    instance_type: v.optional(v.string()),
    vcpu: v.optional(v.number()),
    memory_mib: v.optional(v.number()),
    /**
     * Don't put secrets here. The values are stored as plain text in state and
     * shown in plan output.
     */
    environment_variables: v.optional(
      v.array(v.strictObject({ name: v.string(), value: v.string() })),
    ),
    network: v.optional(
      v.strictObject({
        /** `predefined` makes the container public, and can't be combined with `mode: "private"`. */
        assign_ipv4: v.optional(assignIpSchema),
        assign_ipv6: v.optional(assignIpSchema),
        mode: v.optional(v.picklist(["private", "public"])),
      }),
    ),
  }),
  v.check(
    (configuration) =>
      configuration.instance_type === undefined ||
      (configuration.vcpu === undefined &&
        configuration.memory_mib === undefined),
    "Set either instance_type, or vcpu and memory_mib, not both",
  ),
);

export type ContainerConfiguration = v.InferOutput<typeof configurationSchema>;

// The rules that Cloudflare checks when it validates an application's name.
export const applicationNameSchema = v.pipe(
  v.string(),
  v.nonEmpty("An application name must not be empty"),
  v.maxBytes(253, "An application name must be at most 253 bytes"),
  v.check(
    (name) => !/^[-0-9]/.test(name),
    "An application name must not start with a dash or a digit",
  ),
  v.check(
    (name) => !name.endsWith("-"),
    "An application name must not end with a dash",
  ),
  v.check(
    (name) => !name.includes("--"),
    "An application name must not contain two consecutive dashes",
  ),
);

export type CreateApplication = {
  name: string;
  max_instances: number;
  /**
   * Under the `default` policy the image is set on the application. Under
   * the `durable_object` policy the application takes no image, and the
   * images are set in the Worker's upload.
   */
  scheduling_policy: "default";
  /**
   * Cloudflare requires this key, though `max_instances` replaces it.
   * Wrangler sends 0.
   */
  instances: 0;
  configuration: ContainerConfiguration;
  durable_objects: { namespace_id: string };
};

/** The members of an application that the resources read. */
export type Application = {
  id: string;
  name: string;
  max_instances?: number | null;
  durable_objects?: { namespace_id: string } | null;
};

const applicationsPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/containers/applications`;

const applicationPath = (account: string, applicationId: string) =>
  `${applicationsPath(account)}/${encodeURIComponent(applicationId)}`;

export async function createApplication(
  account: string,
  body: CreateApplication,
): Promise<Application> {
  return await cloudflare<Application>("POST", applicationsPath(account), body);
}

export async function listApplications(
  account: string,
): Promise<Application[]> {
  return (
    (await cloudflare<Application[] | null>(
      "GET",
      applicationsPath(account),
    )) ?? []
  );
}

/** Returns `undefined` if the application doesn't exist. */
export async function getApplication(
  account: string,
  applicationId: string,
): Promise<Application | undefined> {
  try {
    return await cloudflare<Application>(
      "GET",
      applicationPath(account, applicationId),
    );
  } catch (error) {
    if (isApplicationNotFound(error)) return undefined;
    throw error;
  }
}

export async function updateApplication(
  account: string,
  applicationId: string,
  settings: { max_instances: number },
): Promise<void> {
  await cloudflare("PATCH", applicationPath(account, applicationId), settings);
}

/**
 * Starts a rollout that replaces the instances with ones that run
 * `configuration`, 25% of them at a time. Cloudflare finishes the rollout
 * after the call returns.
 *
 * Cloudflare merges the target configuration with the current one, so a key
 * that is left out of it stays as it was. `environment_variables: []` clears
 * the variables.
 */
export async function rollOutConfiguration(
  account: string,
  applicationId: string,
  configuration: ContainerConfiguration,
): Promise<void> {
  await cloudflare(
    "POST",
    `${applicationPath(account, applicationId)}/rollouts`,
    {
      description: "Deployed by notation",
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: 25,
      target_configuration: configuration,
    },
  );
}

export async function deleteApplication(
  account: string,
  applicationId: string,
): Promise<void> {
  await cloudflare("DELETE", applicationPath(account, applicationId));
}

export const registryKindSchema = v.picklist(["ECR", "DockerHub", "GAR"]);

export type RegistryKind = v.InferOutput<typeof registryKindSchema>;

export const registryAuthSchema = v.strictObject({
  /** The Secrets Store secret that holds the private part of the credential. */
  private_credential: v.strictObject({
    store_id: v.string(),
    secret_name: v.string(),
  }),
  /** An AWS access key ID, a Docker Hub username, or a service account email. */
  public_credential: v.string(),
});

export type RegistryAuth = v.InferOutput<typeof registryAuthSchema>;

export type Registry = {
  domain: string;
  kind?: RegistryKind | "default" | null;
};

const registriesPath = (account: string) =>
  `/accounts/${encodeURIComponent(account)}/containers/registries`;

export async function createRegistry(
  account: string,
  body: { domain: string; kind: RegistryKind; auth: RegistryAuth },
): Promise<void> {
  await cloudflare("POST", registriesPath(account), body);
}

/**
 * Returns the registry configured for `domain`, or `undefined`. Cloudflare
 * has no request that gets one registry, so this lists them.
 */
export async function findRegistry(
  account: string,
  domain: string,
): Promise<Registry | undefined> {
  const registries =
    (await cloudflare<Registry[] | null>("GET", registriesPath(account))) ?? [];
  return registries.find((registry) => registry.domain === domain);
}

export async function deleteRegistry(
  account: string,
  domain: string,
): Promise<void> {
  await cloudflare(
    "DELETE",
    `${registriesPath(account)}/${encodeURIComponent(domain)}`,
  );
}
