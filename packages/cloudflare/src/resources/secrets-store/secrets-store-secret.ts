import * as v from "valibot";
import { getPresetSecretValue, recordSecret } from "@notation/core";
import {
  isUnknownAfterApply,
  resource,
  ResourceNotFoundError,
  type BaseResource,
} from "@notation/resource";
import type { sources } from "@notation/std/resources";
import { getValue } from "@notation/std/sources";
import { accountId, rejectAccountReplace } from "src/api/client";
import { findSecretByName, isStoreNotFound } from "src/api/secrets-store";
import { deleteSecretByName, upsertSecretByName } from "./secret-ops";
import type { SecretsStoreInstance } from "./secrets-store";

export const valueFromSchema = v.strictObject({
  Source: v.string(),
  Key: v.optional(v.string()),
  Version: v.optional(v.string()),
});

export type SecretValueFrom = v.InferOutput<typeof valueFromSchema>;

type SecretsStoreSecretParams = {
  AccountId: string;
  /** The ID of the store that holds the secret. */
  StoreId: string;
  Name: string;
  /** Where the secret's value comes from (never the value itself). */
  ValueFrom: SecretValueFrom;
  /** True when an explicit `name` was passed, so destroy leaves it in Cloudflare. */
  Adopted?: boolean;
};

export type SecretsStoreSecretSchema = {
  Key: { AccountId: string; StoreId: string; Name: string };
  CreateParams: SecretsStoreSecretParams;
  UpdateParams: Pick<SecretsStoreSecretParams, "ValueFrom">;
  ReadResult: { SecretId: string };
};

export type SecretsStoreSecretDependencies = {
  store: SecretsStoreInstance;
  value?: sources.SourceValueInstance;
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
    rejectReplace: rejectAccountReplace(
      (previous) =>
        `this secret was created in the account ${previous}. The secret can't move to another account, because its Secrets Store belongs to the account ${previous}.`,
    ),
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
    value: v.pipe(
      v.string(),
      v.nonEmpty(),
      v.maxLength(255),
      v.check(
        (name) => !name.includes("."),
        "Secrets Store secret name cannot contain '.'",
      ),
    ),
  },
  ValueFrom: {
    propertyType: "param",
    presence: "required",
    value: valueFromSchema,
  },
  Adopted: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.boolean(),
  },
  SecretId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

function logicalSecretId(resourceId: string): string {
  return resourceId.startsWith("secret:")
    ? resourceId.slice("secret:".length)
    : resourceId;
}

/**
 * A reference to a secret in a Cloudflare Secrets Store. Writes the secret's
 * value to the store on create/update without ever recording the value or any
 * digest of it in state, params, or outputs.
 */
export const SecretsStoreSecret = secretsStoreSecretSchema
  .defineOperations({
    create: async function (this: BaseResource, params) {
      const { AccountId, StoreId, Name, ValueFrom } = params;
      const logicalId = logicalSecretId(this.id);

      let existingId: null | undefined;
      if (
        ValueFrom.Source === "prompt" &&
        getPresetSecretValue(logicalId) === undefined
      ) {
        // Prompt secrets only fill a missing secret so `notation secret set`
        // before the first deploy is adopted without re-prompting.
        const existing = await findSecretByName(AccountId, StoreId, Name);
        if (existing) return;
        existingId = null;
      }

      const raw = (await getValue(logicalId)).unwrap();
      recordSecret(raw);
      await upsertSecretByName({
        account: AccountId,
        storeId: StoreId,
        name: Name,
        value: raw,
        existingId,
      });
    },

    read: async (key) => {
      let secret;
      try {
        secret = await findSecretByName(key.AccountId, key.StoreId, key.Name);
      } catch (error) {
        if (isStoreNotFound(error)) {
          throw new ResourceNotFoundError("Secrets Store was not found");
        }
        throw error;
      }
      if (!secret) {
        throw new ResourceNotFoundError("Secrets Store secret was not found");
      }
      return {
        ...key,
        SecretId: secret.id,
      };
    },

    update: async function (this: BaseResource, key, _patch, _params, state) {
      const logicalId = logicalSecretId(this.id);
      const raw = (await getValue(logicalId)).unwrap();
      recordSecret(raw);
      await upsertSecretByName({
        account: key.AccountId,
        storeId: key.StoreId,
        name: key.Name,
        value: raw,
        existingId: state?.SecretId,
      });
    },

    delete: async function (this: BaseResource, key, state) {
      // During a replace from stage-scoped to explicit `name`, `this.config`
      // holds the new `Adopted: true` while `state` holds the old record.
      const isAdopted =
        state !== undefined
          ? Boolean(state.Adopted)
          : Boolean((this.config as { Adopted?: boolean })?.Adopted);
      if (isAdopted) {
        // Explicit `name` secrets were adopted or shared across stages, so
        // destroy leaves them in Cloudflare and only removes the state record.
        return;
      }
      await deleteSecretByName({
        account: key.AccountId,
        storeId: key.StoreId,
        name: key.Name,
        secretId: state?.SecretId,
      });
    },

    planNotes: async function (
      this: BaseResource & {
        dependencies: SecretsStoreSecretDependencies;
        config: { Name?: string };
      },
      { decision, params },
    ) {
      if (this.dependencies.value) return undefined;
      if (decision === "update") {
        return ["deploy will ask for a value, or fail without a TTY"];
      }
      if (
        decision !== "create" &&
        decision !== "replace" &&
        decision !== "drift-recreate"
      ) {
        return undefined;
      }
      const storeId = params.StoreId;
      const name =
        typeof params.Name === "string" ? params.Name : this.config.Name;
      if (
        typeof storeId !== "string" ||
        isUnknownAfterApply(storeId) ||
        !name
      ) {
        return ["not set; deploy will ask for it, or fail without a TTY"];
      }
      try {
        const account =
          typeof params.AccountId === "string" &&
          !isUnknownAfterApply(params.AccountId)
            ? params.AccountId
            : accountId();
        const existing = await findSecretByName(account, storeId, name);
        if (existing) return undefined;
      } catch {
        // Store may be inaccessible or not yet created; surface the unset note.
      }
      return ["not set; deploy will ask for it, or fail without a TTY"];
    },
  })
  .requireDependencies<SecretsStoreSecretDependencies>()
  .deriveParams(({ deps }) => ({
    AccountId: accountId(),
    StoreId: deps.store.output.StoreId,
    ValueFrom: deps.value
      ? {
          Source: deps.value.output.Source,
          Key: deps.value.output.Key,
          Version: deps.value.output.Version,
        }
      : { Source: "prompt" },
  }));

export type SecretsStoreSecretInstance = InstanceType<
  typeof SecretsStoreSecret
>;
