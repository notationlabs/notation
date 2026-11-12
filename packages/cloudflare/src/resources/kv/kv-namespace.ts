import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  createNamespace,
  deleteNamespace,
  findNamespaceByTitle,
  getNamespace,
  isNotFound,
  isTitleTaken,
  renameNamespace,
  type Jurisdiction,
  type Mode,
} from "src/api/kv";

export type KVNamespaceSchema = {
  Key: { AccountId: string; NamespaceId: string };
  CreateParams: {
    AccountId: string;
    Title: string;
    Jurisdiction?: Jurisdiction;
    Mode?: Mode;
  };
  UpdateParams: { Title: string };
  ReadResult: {};
};

const kvNamespace = resource<KVNamespaceSchema>({
  type: "cloudflare/kv/KVNamespace",
  provider: "@notation/cloudflare/resources",
});

const recreateSteps =
  "To make this change, remove the namespace from your code and deploy, then add it back and deploy again.";

const kvNamespaceSchema = kvNamespace.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    rejectReplace: (previous, desired) =>
      `CLOUDFLARE_ACCOUNT_ID is ${desired}, but this KV namespace was created in the account ${previous}. A namespace can't move to another account, and replacing it would delete its keys. Set CLOUDFLARE_ACCOUNT_ID back to ${previous}. To deploy to the other account, first run \`notation destroy\` with the old account, or deploy to another stage.`,
    value: v.string(),
  },
  NamespaceId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  /** The namespace's name. It must be unique in the account. */
  Title: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  },
  /** Keeps the namespace's data in the jurisdiction. */
  Jurisdiction: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    rejectReplace: (previous, desired) =>
      `The jurisdiction of this KV namespace is ${previous ?? "not set"}, and the code sets it to ${desired ?? "nothing"}. Cloudflare sets the jurisdiction only when it creates a namespace, so the change would replace the namespace and delete its keys. ${recreateSteps}`,
    value: v.picklist(["eu", "fedramp", "us"]),
  },
  /** `instant` makes a KV Instant namespace. Without it, the namespace is a classic namespace. */
  Mode: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    rejectReplace: (previous, desired) =>
      `The mode of this KV namespace is ${previous ?? "classic"}, and the code sets it to ${desired ?? "classic"}. Cloudflare sets the mode only when it creates a namespace, so the change would replace the namespace and delete its keys. ${recreateSteps}`,
    value: v.literal("instant"),
  },
} as const);

const titleTakenMessage = (account: string, title: string) =>
  `The Cloudflare account ${account} already has a KV namespace titled ${JSON.stringify(title)}. Give this namespace another title, or delete the other namespace if you no longer need it.`;

/** A Workers KV namespace. */
export const KVNamespace = kvNamespaceSchema.defineOperations({
  // Cloudflare rejects a second namespace with the same title, but a create
  // whose outcome is unknown is found again by its title. So create checks
  // first that no other namespace has the title, and `find` can take the
  // namespace with the title as the one that this create made. The check is
  // outside `cloudflareCreate`: if it throws, nothing was created.
  create: async (params) => {
    if (await findNamespaceByTitle(params.AccountId, params.Title)) {
      throw new Error(titleTakenMessage(params.AccountId, params.Title));
    }
    try {
      const namespace = await cloudflareCreate(createNamespace)(
        params.AccountId,
        {
          title: params.Title,
          jurisdiction: params.Jurisdiction,
          mode: params.Mode,
        },
      );
      return { NamespaceId: namespace.id };
    } catch (error) {
      if (isTitleTaken(error)) {
        throw new Error(titleTakenMessage(params.AccountId, params.Title), {
          cause: error,
        });
      }
      throw error;
    }
  },

  find: async (params) => {
    const namespace = await findNamespaceByTitle(
      params.AccountId,
      params.Title,
    );
    if (!namespace) {
      throw new ResourceNotFoundError("No KV namespace has the title");
    }
    return { NamespaceId: namespace.id };
  },

  read: async (key) => {
    const namespace = await getNamespace(key.AccountId, key.NamespaceId);
    if (!namespace) {
      throw new ResourceNotFoundError("KV namespace was not found");
    }
    return {
      AccountId: key.AccountId,
      NamespaceId: key.NamespaceId,
      Title: namespace.title,
      Jurisdiction: namespace.jurisdiction ?? undefined,
      Mode: namespace.mode ?? undefined,
    };
  },

  update: async (key, patch) => {
    if (patch.Title === undefined) return;
    try {
      await renameNamespace(key.AccountId, key.NamespaceId, patch.Title);
    } catch (error) {
      if (isTitleTaken(error)) {
        throw new Error(titleTakenMessage(key.AccountId, patch.Title), {
          cause: error,
        });
      }
      throw error;
    }
  },

  delete: async (key) => {
    try {
      await deleteNamespace(key.AccountId, key.NamespaceId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  },

  deriveParams: () => ({ AccountId: accountId() }),
});

export type KVNamespaceInstance = InstanceType<typeof KVNamespace>;
