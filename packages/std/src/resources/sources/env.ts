import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";
import { loadLocalValue, localRevision, lookup } from "./local-value";
import { trackValidator, type Track } from "./track";

export type EnvSchema = {
  Params: { key: string; track?: Track };
  Value: string;
};

const read = (key: string) => async () => lookup(process.env[key]);

/**
 * The value of an environment variable. Without `track`, it has a new
 * revision on every deploy, so every resource that takes it is written.
 */
export const Env = credentialSourceResource<EnvSchema>({
  type: "std/sources/Env",
  provider: "@notation/std/resources",
})
  .defineSchema({
    /** The name of the environment variable. */
    key: { propertyType: "param", presence: "required", value: v.string() },
    /**
     * Makes `revision` a hash of the value, so that a resource that takes
     * the value is written only when it changes. `"scrypt"` is for generated
     * values only. `"hmac"` needs `NOTATION_TRACK_KEY`.
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
    read: async (params, context) => ({
      revision: await localRevision(
        params.track,
        read(params.key),
        `${params.key} is not set`,
        context,
      ),
    }),
    loadCredential: async (params, state, context) => ({
      value: await loadLocalValue(
        params.track,
        read(params.key),
        `${params.key} is not set`,
        state.revision,
        context,
      ),
    }),
  });

export type EnvInstance = InstanceType<typeof Env>;
