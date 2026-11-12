import { CloudflareApiError, cloudflare } from "./client";

/** Cloudflare's error code for a container application that doesn't exist. */
const APPLICATION_NOT_FOUND = 1609;

/** The Durable Object namespace already has a container application. */
const NAMESPACE_HAS_APPLICATION = 1608;

/** The Worker doesn't declare the namespace's class as a container class. */
const NAMESPACE_NOT_CONTAINER_ENABLED = 1607;

export const isApplicationNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.hasCode(APPLICATION_NOT_FOUND);

export const isNamespaceTaken = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.hasCode(NAMESPACE_HAS_APPLICATION);

export const isNamespaceNotContainerEnabled = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.hasCode(NAMESPACE_NOT_CONTAINER_ENABLED);

// This error has no code of its own. Cloudflare returns it for a while
// after a Worker upload creates the namespace.
export const isNamespaceNotVisibleYet = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.status === 400 &&
  error.hasMessage(/Durable Object namespace was not found/i);

// This error has no code of its own. The same request succeeds when it is
// sent again.
export const isCreateUnavailable = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.hasMessage(/can't create application at this time/i);

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type ContainerConfiguration = {
  image: string;
  instance_type?: string;
  vcpu?: number;
  memory?: string;
  memory_mib?: number;
  disk?: JsonObject;
  environment_variables?: { name: string; value: string }[];
  secrets?: JsonObject[];
  labels?: JsonObject[];
  ports?: JsonObject[];
  network?: {
    assign_ipv4?: "none" | "predefined";
    assign_ipv6?: "none" | "predefined";
    mode?: "private" | "public";
  };
  command?: string[];
  entrypoint?: string[];
  observability?: JsonObject;
  checks?: JsonObject[];
  dns?: JsonObject;
  ssh_public_key_ids?: string[];
};

/** The settings of an application that `PATCH` can change. */
export type ApplicationSettings = {
  max_instances?: number;
  instances?: number;
  rollout_active_grace_period?: number;
  constraints?: JsonObject;
  affinities?: JsonObject;
};

export type CreateApplication = ApplicationSettings & {
  name: string;
  max_instances: number;
  configuration: ContainerConfiguration;
  durable_objects: { namespace_id: string };
  jobs?: boolean;
};

/** The members of an application that the resources read. */
export type Application = {
  id: string;
  name: string;
  max_instances?: number | null;
  instances?: number | null;
  rollout_active_grace_period?: number | null;
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
  settings: ApplicationSettings,
): Promise<void> {
  await cloudflare("PATCH", applicationPath(account, applicationId), settings);
}

/**
 * Starts a rollout that replaces every instance with one that runs
 * `configuration`. Cloudflare finishes the rollout after the call returns.
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
      step_percentage: 100,
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

export type RegistryKind = "ECR" | "DockerHub" | "GAR";

export type RegistryAuth = {
  /** The Secrets Store secret that holds the private part of the credential. */
  private_credential: { store_id: string; secret_name: string };
  /** An AWS access key ID, a Docker Hub username, or a service account email. */
  public_credential: string;
};

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
