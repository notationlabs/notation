import * as v from "valibot";
import { PROMPT_SOURCE } from "@notation/core";
import type { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";

export const secretValueFromSchema = v.object({
  /** The id of the secret's declaration, which `getValue` takes. */
  Secret: v.string(),
  /** The name of the source, such as `infisical`, `prompt` or `produced`. */
  Source: v.string(),
  /**
   * Describes the resource whose create writes a produced value, such as
   * `githubApp({ id: "ci" })`.
   */
  Producer: v.optional(v.string()),
  /** The key that the source is asked for. */
  Key: v.optional(v.string()),
  /** The source's version of the key. It is never derived from the value. */
  Version: v.optional(v.string()),
});

/** Where a secret's value comes from. It never holds the value. */
export type SecretValueFrom = v.InferOutput<typeof secretValueFromSchema>;

/** Throws if `id` is missing. */
export function assertSecretId(
  caller: string,
  id: unknown,
): asserts id is string {
  if (typeof id !== "string" || id === "") {
    throw new Error(
      `${caller} requires an id. The id keys the secret in state and is the default base of its name, so keep it stable.`,
    );
  }
}

/**
 * Adds a `SourceValue` to `group` for a secret that has a source, and
 * returns where the secret's value comes from. Throws if there is a source
 * but no key, or a key but no source.
 */
export function addSecretValue(
  group: ResourceGroup<any>,
  declaration: string,
  config: { id: string; source?: Source; key?: string },
): { value?: std.sources.SourceValueInstance; valueFrom: SecretValueFrom } {
  const { id, source, key } = config;
  if (!source) {
    if (key !== undefined) {
      throw new Error(
        `${declaration} has a key but no source. Give the source that the key is read from.`,
      );
    }
    return { valueFrom: { Secret: id, Source: PROMPT_SOURCE } };
  }
  if (typeof key !== "string") {
    throw new Error(
      `${declaration} has a source but no key. Give the key that the source is asked for.`,
    );
  }
  const value = group.add(
    new std.sources.SourceValue(`value:${id}`, {
      config: { Secret: id, Source: source.name, Key: key },
    }),
  );
  return {
    value,
    valueFrom: {
      Secret: id,
      Source: source.name,
      Key: key,
      Version: value.outputRef("Version") as string,
    },
  };
}
