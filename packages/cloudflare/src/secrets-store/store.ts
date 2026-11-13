import { perCollection, ResourceGroup } from "@notation/resource";
import * as cloudflare from "src/resources";

// Cloudflare's limit on the length of a secret's name.
const SECRET_NAME_MAX_LENGTH = 255;

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
