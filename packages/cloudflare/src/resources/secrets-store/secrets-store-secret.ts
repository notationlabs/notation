import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { getValue, isValueSupplied } from "@notation/std/sources";
import {
  deleteSecretByName,
  findSecretByName,
  writeSecret,
} from "src/api/secrets-store";
import type { SecretsStoreInstance } from "./secrets-store";

/** The `Source` of a secret whose value comes from the prompt. */
export const PROMPT_SOURCE = "prompt";

const valueFromSchema = v.object({
  /** The id of the secret's declaration, which `getValue` takes. */
  Secret: v.string(),
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
  ValueFrom: SecretValueFrom;
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
    presence: "required",
    value: valueFromSchema,
  },
  SecretId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * Writes the secret's value, fetched with `getValue`. It creates the secret,
 * or overwrites the value of the one that exists. A secret whose value comes
 * from the prompt is written only when it is missing, so that a value set
 * with `notation secret set` before the first deploy is kept, unless
 * `notation secret set` is the caller.
 */
async function writeValue(params: SecretsStoreSecretParams): Promise<void> {
  const { AccountId, StoreId, Name, ValueFrom } = params;
  if (
    ValueFrom.Source === PROMPT_SOURCE &&
    !isValueSupplied(ValueFrom.Secret) &&
    (await findSecretByName(AccountId, StoreId, Name))
  ) {
    return;
  }
  await writeSecret(
    AccountId,
    StoreId,
    Name,
    (await getValue(ValueFrom.Secret)).unwrap(),
  );
}

/**
 * A reference to a secret in a Cloudflare Secrets Store. Its record holds
 * where the secret is and where its value comes from, and never the value.
 *
 * Create and update write the value. A change to `ValueFrom`, such as a new
 * version from the source, updates the secret. Read finds the secret by
 * name, so a secret recreated outside notation shows as a changed
 * `SecretId`, and a deleted one as drift, which the next deploy creates
 * again.
 */
export const SecretsStoreSecret = secretsStoreSecretSchema
  .defineOperations({
    create: async (params) => {
      await writeValue(params);
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
      await writeValue(params);
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
