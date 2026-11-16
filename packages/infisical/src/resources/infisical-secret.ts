import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";
import {
  assertTrackKey,
  trackRevision,
  trackValidator,
  type Track,
} from "@notation/std/track";
import { recordSecretValue } from "@notation/utils";
import { getSecret, where, type SecretAddress } from "./client";

export type InfisicalSecretSchema = {
  Params: SecretAddress & { track?: Track };
  Value: string;
};

/**
 * Infisical deleted the secret and added another with the same key after
 * deploy read it. The new secret's versions are numbered from 1, so the
 * version in the revision may name a value of the new secret.
 */
export class SecretReplacedError extends Error {
  constructor(address: SecretAddress) {
    super(
      `\`${address.key}\` in ${where(address)} was deleted and added again after deploy read it. Run deploy again.`,
    );
    this.name = "SecretReplacedError";
  }
}

function assertNotEmpty(address: SecretAddress, value: string) {
  if (value === "") {
    throw new Error(
      `The value of \`${address.key}\` in ${where(address)} is empty.`,
    );
  }
}

/**
 * A secret in Infisical. It logs in with `INFISICAL_TOKEN`, or with a
 * machine identity's client ID and secret, or with `INFISICAL_IDENTITY_ID`
 * and the CI platform's OIDC token. `INFISICAL_DOMAIN` sets the instance.
 *
 * Without `track`, its revision is the secret's ID and version, so a
 * resource that takes the value is written when the version changes. A
 * secret that refers to another secret keeps its version when the other
 * secret changes, so its revision is the execution ID, and it is written
 * on every deploy.
 */
export const InfisicalSecret = credentialSourceResource<InfisicalSecretSchema>({
  type: "infisical/secrets/InfisicalSecret",
  provider: "@notation/infisical/resources",
})
  .defineSchema({
    projectId: {
      propertyType: "param",
      presence: "required",
      value: v.string(),
    },
    /** The environment's slug, such as `prod`. */
    environment: {
      propertyType: "param",
      presence: "required",
      value: v.string(),
    },
    /** The folder of the secret, such as `/orders`. */
    path: { propertyType: "param", presence: "required", value: v.string() },
    key: { propertyType: "param", presence: "required", value: v.string() },
    /**
     * Makes `revision` a hash of the value with each reference replaced, so
     * that a resource that takes the value is written only when it changes.
     * `"scrypt"` is for generated values only. `"hmac"` needs
     * `NOTATION_TRACK_KEY`.
     */
    track: {
      propertyType: "param",
      presence: "optional",
      value: trackValidator,
    },
    revision: {
      propertyType: "computed",
      presence: "required",
      value: v.string(),
    },
    value: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    // The revision is one of: `<id>:<version>` for a secret without
    // references, the execution ID for a secret with a reference, or an
    // `hmac:` or `scrypt:` hash with `track`. `loadCredential` tells the
    // formats apart. With the execution ID, `loadCredential` fetches the
    // current value with each reference replaced, so the value is not fixed
    // for the revision: consumers written before and after a resumed deploy
    // can get different values.
    read: async (params, context) => {
      if (params.track) {
        assertTrackKey(params.track);
        const secret = await getSecret(params, {
          expandSecretReferences: true,
        });
        recordSecretValue(secret.secretValue);
        return {
          revision: await trackRevision(
            params.track,
            context,
            secret.secretValue,
          ),
        };
      }
      // Infisical's API does not say whether a secret refers to another.
      // The value with each reference replaced differs from the stored
      // text exactly when it does.
      const [stored, expanded] = await Promise.all([
        getSecret(params, { expandSecretReferences: false }),
        getSecret(params, { expandSecretReferences: true }),
      ]);
      recordSecretValue(stored.secretValue);
      recordSecretValue(expanded.secretValue);
      if (stored.secretValue !== expanded.secretValue) {
        return { revision: context.executionId };
      }
      // The ID is in the revision because a secret that is deleted and
      // added again is numbered from 1.
      return { revision: `${stored.id}:${stored.version}` };
    },
    loadCredential: async (state, context) => {
      if (state.track || state.revision === context.executionId) {
        const secret = await getSecret(state, {
          expandSecretReferences: true,
        });
        assertNotEmpty(state, secret.secretValue);
        if (
          state.track &&
          (await trackRevision(
            state.track,
            context,
            secret.secretValue,
          )) !== state.revision
        ) {
          throw new Error(
            `The value of \`${state.key}\` in ${where(state)} changed after deploy read it. Run deploy again.`,
          );
        }
        return secret.secretValue;
      }
      const separator = state.revision.lastIndexOf(":");
      const id = state.revision.slice(0, separator);
      const version = Number(state.revision.slice(separator + 1));
      // The stored text of this version holds no reference, as read found.
      const secret = await getSecret(state, {
        expandSecretReferences: false,
        version,
      });
      if (secret.id !== id) throw new SecretReplacedError(state);
      assertNotEmpty(state, secret.secretValue);
      return secret.secretValue;
    },
  });

export type InfisicalSecretInstance = InstanceType<typeof InfisicalSecret>;
