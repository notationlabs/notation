import { PROMPT_SOURCE } from "@notation/core";
import type { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import type { SecretValueFrom } from "src/resources/secrets-store/secrets-store-secret";

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
 * but no key.
 */
export function addSecretValue(
  group: ResourceGroup<any>,
  declaration: string,
  config: { id: string; source?: Source; key?: string },
): { value?: std.sources.SourceValueInstance; valueFrom: SecretValueFrom } {
  const { id, source, key } = config;
  if (!source) return { valueFrom: { Secret: id, Source: PROMPT_SOURCE } };
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
