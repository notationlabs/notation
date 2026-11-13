import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  accountId,
  CloudflareApiError,
  cloudflareCreate,
} from "src/api/client";
import {
  createStore,
  DEFAULT_STORE_NAME,
  getStore,
  listStores,
} from "src/api/secrets-store";

export type SecretsStoreSchema = {
  Key: { AccountId: string; StoreId: string };
  CreateParams: { AccountId: string };
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
    value: v.string(),
  },
  StoreId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
} as const);

async function adoptStore(account: string) {
  const [store] = await listStores(account);
  return store && { StoreId: store.id };
}

/**
 * The account's Secrets Store. Cloudflare allows one per account, and every
 * app and stage in the account shares it. Create adopts the store if there
 * is one, and otherwise creates one with the name that the dashboard uses.
 * Delete leaves the store, because other apps and stages may use it.
 */
export const SecretsStore = secretsStoreSchema.defineOperations({
  create: async (params) => {
    const adopted = await adoptStore(params.AccountId);
    if (adopted) return adopted;
    try {
      const store = await cloudflareCreate(createStore)(
        params.AccountId,
        DEFAULT_STORE_NAME,
      );
      return { StoreId: store.id };
    } catch (error) {
      // Another deploy may have created the account's store since the list.
      // Cloudflare rejects a second store, so the list is read again.
      if (!(error instanceof CloudflareApiError) || error.status >= 500) {
        throw error;
      }
      const raced = await adoptStore(params.AccountId);
      if (raced) return raced;
      throw error;
    }
  },

  // A create with an unknown outcome made the account's store, or nothing.
  find: async (params) => {
    const adopted = await adoptStore(params.AccountId);
    if (!adopted) {
      throw new ResourceNotFoundError("The account has no Secrets Store");
    }
    return adopted;
  },

  read: async (key) => {
    if (!(await getStore(key.AccountId, key.StoreId))) {
      throw new ResourceNotFoundError("Secrets Store was not found");
    }
    return key;
  },

  delete: async () => {},

  deriveParams: () => ({ AccountId: accountId() }),
});

export type SecretsStoreInstance = InstanceType<typeof SecretsStore>;
