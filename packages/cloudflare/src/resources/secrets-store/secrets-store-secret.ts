import * as v from "valibot";
import {
  PRODUCED_SOURCE,
  PROMPT_SOURCE,
  registerSecretStore,
} from "@notation/core";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { getValue } from "@notation/std/sources";
import {
  createSecret,
  deleteSecret,
  findSecretByName,
  setSecretValue,
  writeSecret,
} from "src/api/secrets-store";
import { secretValueFromSchema, type SecretValueFrom } from "src/secrets/value";
import type { SecretsStoreInstance } from "./secrets-store";

export { secretValueFromSchema, type SecretValueFrom };

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
  UpdateParams: Pick<SecretsStoreSecretParams, "StageScoped" | "ValueFrom">;
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
    value: v.boolean(),
  },
  ValueFrom: {
    propertyType: "param",
    presence: "required",
    value: secretValueFromSchema,
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
 * with `notation secret set` is kept.
 */
async function writeValue(params: SecretsStoreSecretParams): Promise<void> {
  const { AccountId, StoreId, Name, ValueFrom } = params;
  const existing = await findSecretByName(AccountId, StoreId, Name);
  if (existing && ValueFrom.Source === PROMPT_SOURCE) return;
  const value = (await getValue(ValueFrom.Secret)).unwrap();
  if (existing) {
    await setSecretValue(AccountId, StoreId, existing.id, value);
  } else {
    await createSecret(AccountId, StoreId, Name, value);
  }
}

/**
 * Checks that the producer wrote the value. The secret depends on the
 * producer, so the producer's create has run. Cloudflare can't create a
 * secret without a value, so the producer creates the secret, and this
 * create only records it.
 */
async function claimProduced(params: SecretsStoreSecretParams): Promise<void> {
  const { AccountId, StoreId, Name, ValueFrom } = params;
  if (await findSecretByName(AccountId, StoreId, Name)) return;
  throw new Error(
    [
      `The secret ${Name} of \`${ValueFrom.Secret}\` is missing. Only the create of its producer writes the value.`,
      ValueFrom.Rotation,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

const isProduced = (params: Pick<SecretsStoreSecretParams, "ValueFrom">) =>
  params.ValueFrom.Source === PRODUCED_SOURCE;

/**
 * A reference to a secret in a Cloudflare Secrets Store. Its record holds
 * where the secret is and where its value comes from, and never the value.
 *
 * Create and update write the value. A change to `ValueFrom`, such as a new
 * version from the source, updates the secret. A change to `StageScoped`
 * only changes the record.
 *
 * When `ValueFrom.Source` is `produced`, the producer's create writes the
 * value. Create then only checks that the secret exists, and update writes
 * nothing. Delete deletes the secret as for any other source.
 *
 * Read finds the secret by name, so a secret recreated outside notation
 * shows as a changed `SecretId`, and a deleted one as drift, which the next
 * deploy creates again.
 */
export const SecretsStoreSecret = secretsStoreSecretSchema
  .defineOperations({
    create: async (params) => {
      await (isProduced(params) ? claimProduced(params) : writeValue(params));
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

    update: async (_key, patch, params) => {
      if (patch.ValueFrom && !isProduced(params)) await writeValue(params);
    },

    delete: async (key, state) => {
      if (!state.StageScoped) return;
      await deleteSecret(key.AccountId, key.StoreId, key.Name);
    },
  })
  .requireDependencies<SecretsStoreSecretDependencies>()
  .deriveParams(async ({ deps }) => ({
    AccountId: deps.store.output.AccountId,
    StoreId: deps.store.output.StoreId,
  }));

/** The provider of the targets that secrets with a produced source register. */
export const SECRETS_STORE_PROVIDER = "@notation/cloudflare/resources";

type TargetParams = { AccountId: string; StoreId: string; Name: string };

// Registered when this module loads. The resource registry loads this
// module for a secret's record that is no longer in code, so a producer
// whose secrets were removed still finds the store.
registerSecretStore(SECRETS_STORE_PROVIDER, {
  write: async (params, value) => {
    const { AccountId, StoreId, Name } = params as TargetParams;
    await writeSecret(AccountId, StoreId, Name, value);
  },
  delete: async (params) => {
    const { AccountId, StoreId, Name } = params as TargetParams;
    await deleteSecret(AccountId, StoreId, Name);
  },
  has: async (params) => {
    const { AccountId, StoreId, Name } = params as TargetParams;
    return (await findSecretByName(AccountId, StoreId, Name)) !== undefined;
  },
});

export type SecretsStoreSecretInstance = InstanceType<
  typeof SecretsStoreSecret
>;
