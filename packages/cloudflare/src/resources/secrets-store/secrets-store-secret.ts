import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import {
  deleteSecret,
  findSecretByName,
  writeSecret,
} from "src/api/secrets-store";
import type { SecretsStoreInstance } from "./secrets-store";

type SecretsStoreSecretParams = {
  AccountId: string;
  StoreId: string;
  Name: string;
  /**
   * The value, from a credential of another resource, such as
   * `token.credentials.Value`. State holds a marker in its place.
   */
  Value: string;
};

export type SecretsStoreSecretSchema = {
  Key: { AccountId: string; StoreId: string; Name: string };
  CreateParams: SecretsStoreSecretParams;
  UpdateParams: Pick<SecretsStoreSecretParams, "Value">;
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
    // Cloudflare rejects a name of more than 255 characters with
    // `secret_name_too_long`.
    physicalName: { maxLength: 255 },
  },
  Value: {
    propertyType: "param",
    presence: "required",
    sensitive: true,
    value: v.string(),
  },
  SecretId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * A secret in a Cloudflare Secrets Store, which holds the value of a
 * credential of another resource. Deploy names it
 * `<app>--<stage>--<id>-<instance>`. Its record holds where the secret is,
 * and never the value.
 *
 * Create writes the value. It overwrites the value of a secret that has the
 * name already, as after a create whose outcome was unknown. Update writes
 * the value when the credential has a new version. Read finds the secret by name, so a secret recreated outside
 * notation shows as a changed `SecretId`, and a deleted one as drift, which
 * the next deploy creates again.
 */
export const SecretsStoreSecret = secretsStoreSecretSchema
  .defineOperations({
    create: async (params) => {
      await writeSecret(
        params.AccountId,
        params.StoreId,
        params.Name,
        params.Value,
      );
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

    // `Value` is undefined unless the credential has a new version.
    update: async (key, patch) => {
      if (patch.Value === undefined) return;
      await writeSecret(key.AccountId, key.StoreId, key.Name, patch.Value);
    },

    delete: async (key) => {
      await deleteSecret(key.AccountId, key.StoreId, key.Name);
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
