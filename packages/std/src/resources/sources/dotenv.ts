import fs from "node:fs/promises";
import { parseEnv } from "node:util";
import * as v from "valibot";
import { fromProjectRoot } from "@notation/core";
import { credentialSourceResource } from "@notation/resource";
import { isErrorWithCode } from "@notation/utils";
import { loadLocalValue, localRevision, lookup } from "./local-value";
import { trackValidator, type Track } from "./track";

export type DotenvSchema = {
  Params: { path: string; key: string; track?: Track };
  Value: string;
};

// A missing file holds no key.
const read = (path: string, key: string) => async () => {
  let text: string;
  try {
    text = await fs.readFile(fromProjectRoot(path), "utf8");
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) throw error;
    text = "";
  }
  return lookup(parseEnv(text)[key]);
};

/**
 * The value of a key in a `.env` file. Without `track`, it has a new
 * revision on every deploy, so every resource that takes it is written.
 */
export const Dotenv = credentialSourceResource<DotenvSchema>({
  type: "std/sources/Dotenv",
  provider: "@notation/std/resources",
})
  .defineSchema({
    /** The path of the file, relative to the project root. */
    path: { propertyType: "param", presence: "required", value: v.string() },
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
        read(params.path, params.key),
        `${params.key} is not set in ${params.path}`,
        context,
      ),
    }),
    loadCredential: async (params, state, context) => ({
      value: await loadLocalValue(
        params.track,
        read(params.path, params.key),
        `${params.key} is not set in ${params.path}`,
        state.revision,
        context,
      ),
    }),
  });

export type DotenvInstance = InstanceType<typeof Dotenv>;
