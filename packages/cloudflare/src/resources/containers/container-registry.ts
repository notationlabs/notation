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
  registryAuthSchema,
  registryKindSchema,
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
    value: v.pipe(
      v.string(),
      v.regex(
        /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
        "Domain must be a lowercase hostname, such as docker.io, with no scheme or path",
      ),
    ),
  },
  Kind: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: registryKindSchema,
  },
  // The private part of the credential is a reference to a Secrets Store
  // secret, not its value, so nothing here is sensitive.
  Auth: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: registryAuthSchema,
  },
} as const);

/**
 * Gives Containers the credentials to pull images from a private registry.
 * Cloudflare can't change a registry's credentials, so a change replaces the
 * registry. The read doesn't return `Kind` or `Auth`, so a change made
 * outside notation to them is not seen.
 */
export const ContainerRegistry = containerRegistrySchema
  .defineOperations({
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
      // `Kind` is left out: it is immutable, so a value that Cloudflare
      // returns in another case would replace the registry.
      return { AccountId: key.AccountId, Domain: key.Domain };
    },

    // Cloudflare lists no error for a registry that doesn't exist. When the
    // delete fails, the list shows whether the registry is gone.
    delete: async (key) => {
      try {
        await deleteRegistry(key.AccountId, key.Domain);
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
        let registry;
        try {
          registry = await findRegistry(key.AccountId, key.Domain);
        } catch (listError) {
          error.cause = listError;
          throw error;
        }
        if (registry) throw error;
      }
    },
  })
  .requireDependencies<{}>()
  .deriveParams(async () => ({ AccountId: accountId() }));

export type ContainerRegistryInstance = InstanceType<typeof ContainerRegistry>;
