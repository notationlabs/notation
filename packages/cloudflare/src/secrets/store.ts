import {
  getActiveResourceCollection,
  perCollection,
  ResourceGroup,
} from "@notation/resource";
import * as cloudflare from "src/resources";

export class SecretsStoreGroup extends ResourceGroup<{}> {
  readonly store: cloudflare.secretsStore.SecretsStoreInstance;

  constructor() {
    super("cloudflare/secretsStore", "secrets-store");
    this.store = this.add(
      new cloudflare.secretsStore.SecretsStore("secrets-store"),
    );
  }
}

const secretsStoreGroup = perCollection(
  "@notation/cloudflare/secretsStore",
  () => new SecretsStoreGroup(),
);

/**
 * Ensures the singleton `SecretsStore` (`secrets-store`) exists in the active
 * resource collection and returns it.
 */
export function ensureSecretsStore(): cloudflare.secretsStore.SecretsStoreInstance {
  return (secretsStoreGroup() ?? new SecretsStoreGroup()).store;
}

const claimedSecretIds = perCollection(
  "@notation/cloudflare/secretIds",
  () => new Set<string>(),
);

const claimedSecretNames = perCollection(
  "@notation/cloudflare/secretNames",
  () => new Map<string, string>(),
);

/**
 * Returns `<app>--<stage>--<id>` when collecting a deployment graph, or `id`
 * when no scope is active.
 */
export function scopedSecretName(id: string): string {
  const scope = getActiveResourceCollection()?.scope;
  return scope ? `${scope.app}--${scope.stage}--${id}` : id;
}

export function assertSecretName(
  caller: string,
  name: unknown,
  maxLength: number,
): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${caller} requires a non-empty secret name.`);
  }
  if (name.length > maxLength) {
    throw new Error(
      `Invalid ${caller} name ${JSON.stringify(name)}: Cloudflare accepts at most ${maxLength} characters (got ${name.length}).`,
    );
  }
  if (name.includes(".")) {
    throw new Error(
      `Invalid ${caller} name ${JSON.stringify(name)}: Cloudflare Secrets Store rejects names containing ".".`,
    );
  }
}

export function claimSecretIdentity(
  caller: string,
  id: string,
  storeName: string,
): void {
  const ids = claimedSecretIds();
  if (ids?.has(id)) {
    throw new Error(
      `Duplicate secret id "${id}": another secret() or accountToken() in this deployment already uses it.`,
    );
  }
  const names = claimedSecretNames();
  const previous = names?.get(storeName);
  if (previous) {
    throw new Error(
      `${previous} and ${caller}({ id: "${id}" }) give two Secrets Store secrets the same name, "${storeName}". Give one of them another id or name.`,
    );
  }
  ids?.add(id);
  names?.set(storeName, `${caller}({ id: "${id}" })`);
}
