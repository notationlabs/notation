import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  accountId,
  CloudflareApiError,
  cloudflareCreate,
} from "src/api/client";
import {
  createRegistry,
  deleteRegistry,
  findRegistry,
  type RegistryAuth,
  type RegistryKind,
} from "src/api/containers";

export type ContainerRegistrySchema = {
  Key: { AccountId: string; Domain: string };
  CreateParams: {
    AccountId: string;
    /** The registry's hostname, such as `docker.io`, without a scheme or path. */
    Domain: string;
    /** `DockerHub` for `docker.io`, `ECR` for AWS ECR, or `GAR` for Google Artifact Registry. */
    Kind: RegistryKind;
    Auth: RegistryAuth;
  };
  UpdateParams: {};
  ReadResult: {};
};

const containerRegistry = resource<ContainerRegistrySchema>({
  type: "cloudflare/containers/ContainerRegistry",
  provider: "@notation/cloudflare/resources",
});

const containerRegistrySchema = containerRegistry.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  Domain: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.string(),
  },
  Kind: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.picklist(["ECR", "DockerHub", "GAR"]),
  },
  // The private part of the credential is a reference to a Secrets Store
  // secret, not its value, so nothing here is sensitive.
  Auth: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.object({
      private_credential: v.object({
        store_id: v.string(),
        secret_name: v.string(),
      }),
      public_credential: v.string(),
    }),
  },
} as const);

/**
 * Gives Containers the credentials to pull images from a private registry.
 * Cloudflare can't change a registry's credentials, so a change replaces the
 * registry. The read doesn't return `Auth`, so a change made outside
 * notation to the credentials is not seen.
 */
export const ContainerRegistry = containerRegistrySchema.defineOperations({
  // Check first, so that the create doesn't take over a registry that it
  // didn't make. The check is outside `cloudflareCreate`: if it throws,
  // nothing was created.
  create: async (params) => {
    if (await findRegistry(params.AccountId, params.Domain)) {
      throw new Error(
        `The Cloudflare account ${params.AccountId} already has credentials for the registry ${params.Domain}. Delete them before notation can manage them.`,
      );
    }
    await cloudflareCreate(createRegistry)(params.AccountId, {
      domain: params.Domain,
      kind: params.Kind,
      auth: params.Auth,
    });
  },

  read: async (key) => {
    const registry = await findRegistry(key.AccountId, key.Domain);
    if (!registry) {
      throw new ResourceNotFoundError("Container registry was not found");
    }
    return {
      AccountId: key.AccountId,
      Domain: key.Domain,
      Kind:
        registry.kind === "default" ? undefined : (registry.kind ?? undefined),
    };
  },

  // Cloudflare lists no error for a registry that doesn't exist. When the
  // delete fails, the list shows whether the registry is gone.
  delete: async (key) => {
    try {
      await deleteRegistry(key.AccountId, key.Domain);
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      if (await findRegistry(key.AccountId, key.Domain)) throw error;
    }
  },

  deriveParams: async () => ({ AccountId: accountId() }),
});

export type ContainerRegistryInstance = InstanceType<typeof ContainerRegistry>;
