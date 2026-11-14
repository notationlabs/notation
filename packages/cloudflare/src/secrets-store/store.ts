import { PROMPT_SOURCE } from "@notation/core";
import { perCollection, ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import * as cloudflare from "src/resources";
import type { SecretValueFrom } from "src/resources/secrets-store/secrets-store-secret";

// Cloudflare's limit on the length of a secret's name.
export const SECRET_NAME_MAX_LENGTH = 255;

export class SecretsStoreGroup extends ResourceGroup {
  platform = "cloudflare";
  readonly store: cloudflare.secretsStore.SecretsStoreInstance;

  constructor() {
    super("cloudflare/secretsStore", "default");
    this.store = this.add(
      new cloudflare.secretsStore.SecretsStore("secrets-store"),
    );
  }
}

// One store for each collection, which every secret and token depends on.
const accountStore = perCollection(
  "@notation/cloudflare/secretsStore",
  () => new SecretsStoreGroup(),
);

/** The account's Secrets Store. Each call returns the same store. */
export function secretsStoreGroup(): SecretsStoreGroup {
  return accountStore() ?? new SecretsStoreGroup();
}

const claimedNames = perCollection(
  "@notation/cloudflare/secretNames",
  () => new Map<string, string>(),
);

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
 * Throws if Cloudflare would reject `name` as a secret's name, or if
 * another secret or token of the app has it.
 */
export function claimSecretName(name: string, declaration: string): void {
  if (name.length > SECRET_NAME_MAX_LENGTH) {
    throw new Error(
      `${declaration} has the secret name "${name}", which is longer than Cloudflare's limit of ${SECRET_NAME_MAX_LENGTH} characters.`,
    );
  }
  if (name.includes(".")) {
    throw new Error(
      `${declaration} has the secret name "${name}", but Cloudflare rejects a secret name with a dot.`,
    );
  }
  const claimed = claimedNames();
  if (!claimed) return;
  const previous = claimed.get(name);
  if (previous) {
    throw new Error(
      `${previous} and ${declaration} give two secrets the same name, "${name}". Give one of them another id or name.`,
    );
  }
  claimed.set(name, declaration);
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
