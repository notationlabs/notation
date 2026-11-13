import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
} from "@notation/resource";
import {
  accountId,
  CloudflareApiError,
  cloudflareCreate,
  rejectAccountReplace,
} from "src/api/client";
import { createStore, getStore, listStores } from "src/api/secrets-store";

const DEFAULT_STORE_NAME = "default_secrets_store";

type SecretsStoreParams = {
  AccountId: string;
};

export type SecretsStoreSchema = {
  Key: { AccountId: string; StoreId: string };
  CreateParams: SecretsStoreParams;
  UpdateParams: {};
  ReadResult: {};
};

const secretsStore = resource<SecretsStoreSchema>({
  type: "cloudflare/secrets-store/SecretsStore",
  provider: "@notation/cloudflare/resources",
});

const secretsStoreSchema = secretsStore.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    rejectReplace: rejectAccountReplace(
      (previous) => `this Secrets Store belongs to the account ${previous}.`,
    ),
    value: v.string(),
  },
  StoreId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
} as const);

/**
 * The Cloudflare Secrets Store for an account. Cloudflare allows one store per
 * account, shared across stages, so `create` adopts an existing store if
 * present and `delete` is a no-op.
 */
export const SecretsStore = secretsStoreSchema.defineOperations({
  create: async (params) => {
    const existing = await listStores(params.AccountId);
    if (existing.length > 0) {
      return { StoreId: existing[0]!.id };
    }
    try {
      const created = await cloudflareCreate(createStore)(
        params.AccountId,
        DEFAULT_STORE_NAME,
      );
      return { StoreId: created.id };
    } catch (error) {
      // Another concurrent deploy may have created the account's store between
      // our list and create calls. List again and adopt the winner's store.
      if (error instanceof CloudflareApiError && error.status < 500) {
        const raced = await listStores(params.AccountId);
        if (raced.length > 0) {
          return { StoreId: raced[0]!.id };
        }
      }
      throw error;
    }
  },

  find: async (params) => {
    const existing = await listStores(params.AccountId);
    if (existing.length === 0) {
      throw new ResourceNotFoundError("Secrets Store was not found");
    }
    return { StoreId: existing[0]!.id };
  },

  read: async (key) => {
    const store = await getStore(key.AccountId, key.StoreId);
    if (!store) {
      throw new ResourceNotFoundError("Secrets Store was not found");
    }
    return { ...key };
  },

  delete: async () => {
    // The Secrets Store belongs to the account and is shared across stages.
  },

  deriveParams: () => ({
    AccountId: accountId(),
  }),
});

export type SecretsStoreInstance = InstanceType<typeof SecretsStore>;
