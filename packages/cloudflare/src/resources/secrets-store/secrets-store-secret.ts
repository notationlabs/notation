import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { deleteSecretByName, findSecretByName } from "src/api/secrets-store";
import type { SecretsStoreInstance } from "./secrets-store";

const valueFromSchema = v.object({
  /** The name of the source, such as `infisical`, or `prompt`. */
  Source: v.string(),
  /** The key that the source is asked for. */
  Key: v.optional(v.string()),
  /** The source's version of the key. It is never derived from the value. */
  Version: v.optional(v.string()),
});

/** Where a secret's value comes from. It never holds the value. */
export type SecretValueFrom = v.InferOutput<typeof valueFromSchema>;

type SecretsStoreSecretParams = {
  AccountId: string;
  StoreId: string;
  Name: string;
  /**
   * True when the name is `<app>--<stage>--<id>`. Delete then deletes the
   * secret. A secret with an explicit name was adopted, so delete leaves it.
   */
  StageScoped: boolean;
  ValueFrom?: SecretValueFrom;
};

export type SecretsStoreSecretSchema = {
  Key: { AccountId: string; StoreId: string; Name: string };
  CreateParams: SecretsStoreSecretParams;
  UpdateParams: Pick<SecretsStoreSecretParams, "ValueFrom">;
  ReadResult: { SecretId: string };
};

export type SecretsStoreSecretDependencies = {
  store: SecretsStoreInstance;
};

const secretsStoreSecret = resource<SecretsStoreSecretSchema>({
  type: "cloudflare/secrets-store/SecretsStoreSecret",
  provider: "@notation/cloudflare/resources",
});

const secretsStoreSecretSchema = secretsStoreSecret.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  StoreId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.pipe(v.string(), v.nonEmpty()),
  },
  StageScoped: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.boolean(),
  },
  ValueFrom: {
    propertyType: "param",
    presence: "optional",
    value: valueFromSchema,
  },
  SecretId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

function missingSecretError(params: SecretsStoreSecretParams): Error {
  return new Error(
    `The secret ${params.Name} isn't in the Secrets Store ${params.StoreId} of the Cloudflare account ${params.AccountId}. Notation doesn't write secret values yet. Create the secret with \`wrangler secrets-store secret create ${params.StoreId} --name ${params.Name} --scopes workers --remote\`, or on the Secrets Store page of the Cloudflare dashboard, then deploy again.`,
  );
}

// Writing a value needs the value sources of RFC 0017, which this version
// doesn't have.
function valueFromError(params: SecretsStoreSecretParams): Error {
  return new Error(
    `The secret ${params.Name} takes its value from ${params.ValueFrom?.Source}, but this version of @notation/cloudflare can't write a secret's value. Set the secret with wrangler or in the Cloudflare dashboard, and remove its ValueFrom.`,
  );
}

/**
 * A reference to a secret in a Cloudflare Secrets Store. Its record holds
 * where the secret is, and never its value.
 *
 * Create only finds a secret that already exists, and fails if there is
 * none. Read finds the secret by name, so a secret recreated outside
 * notation shows as a changed `SecretId`, and a deleted one as drift.
 */
export const SecretsStoreSecret = secretsStoreSecretSchema
  .defineOperations({
    create: async (params) => {
      if (params.ValueFrom) throw valueFromError(params);
      const secret = await findSecretByName(
        params.AccountId,
        params.StoreId,
        params.Name,
      );
      if (!secret) throw missingSecretError(params);
    },

    read: async (key) => {
      const secret = await findSecretByName(
        key.AccountId,
        key.StoreId,
        key.Name,
      );
      if (!secret) {
        throw new ResourceNotFoundError("No secret in the store has the name");
      }
      return { ...key, SecretId: secret.id };
    },

    update: async (_key, _patch, params) => {
      if (params.ValueFrom) throw valueFromError(params);
    },

    delete: async (key, state) => {
      if (!state.StageScoped) return;
      await deleteSecretByName(key.AccountId, key.StoreId, key.Name);
    },
  })
  .requireDependencies<SecretsStoreSecretDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.store.output.AccountId,
    StoreId: deps.store.output.StoreId,
  }));

export type SecretsStoreSecretInstance = InstanceType<
  typeof SecretsStoreSecret
>;
