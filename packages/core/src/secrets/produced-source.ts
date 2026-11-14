import {
  getActiveResourceCollection,
  onEvaluationEnd,
  type BaseResource,
} from "@notation/resource";
import { recordSecretValue } from "@notation/utils";
import type { Source } from "./context";

/**
 * Where a producer writes a secret value. The producer holds its targets in
 * a param, so a target never holds a value. `provider` is the name that a
 * store implementation was registered with in `registerSecretStore`, and
 * `params` says where the secret is in that store.
 */
export type SecretTarget = {
  provider: string;
  params: Record<string, unknown>;
};

/** Writes, deletes and checks secret values in one kind of store. */
export type SecretStore = {
  /** Creates the secret, or overwrites the value of the one that exists. */
  write(params: Record<string, unknown>, value: string): Promise<void>;
  /** Succeeds when the secret is already gone. */
  delete(params: Record<string, unknown>): Promise<void>;
  has(params: Record<string, unknown>): Promise<boolean>;
};

/**
 * A value that a resource gets only once, in the response to its create,
 * such as the value of an API token. The resource exposes it in `sources`,
 * and a secret takes it as its `source`. The resource's create writes the
 * value to the target of each secret that takes it. Deploy can't ask it for
 * a value, so it is not a `Source`.
 */
export interface ProducedSource {
  "~producedSource": {
    /** Names the producer's declaration, such as `accountToken({ id: "ci" })`. */
    producer: string;
    /**
     * Says how to rotate the producer, so that its create writes a new
     * value. Errors and refusals about a secret that takes the value show it.
     */
    rotation: string;
    /** The resource whose create writes the value. Each secret depends on it. */
    resource: BaseResource;
    /**
     * Adds a target that the producer's create writes the value to. A secret
     * calls it when it is constructed.
     */
    register(target: SecretTarget): void;
  };
}

/** What a secret's `source` can be. */
export type SecretSource = Source | ProducedSource;

export function isProducedSource(source: unknown): source is ProducedSource {
  return (
    typeof source === "object" && source !== null && "~producedSource" in source
  );
}

/**
 * Makes the produced source `name` of `resource`. Each target that a secret
 * registers is contributed to the collected param `param` of `resource`.
 * Output refs in a target make `resource` depend on
 * the resources they refer to, such as the store. When evaluation ends, it
 * throws if no secret takes the source, as the value would be lost. It is
 * an engine mechanism for resource packages, not user-facing API.
 */
export function producedSource(options: {
  producer: string;
  resource: BaseResource;
  /** The name in `sources`, such as `value`. */
  name: string;
  /**
   * A collected param of `resource` that holds a list of `SecretTarget`,
   * with `(items: unknown[]) => items.flat() as SecretTarget[]` as its
   * `collect`. The engine sorts the contributions by content before
   * `collect`, so the order of the secrets in code doesn't change the
   * param. Make it immutable: only a create gets a value to write to a new
   * target.
   */
  param: string;
  /**
   * Says how to rotate the producer, such as which resource to delete in a
   * dashboard before the next deploy. The refusal of `notation secret` and
   * the error for a missing secret show it. Without it, they only say to
   * rotate the producer.
   */
  rotation?: string;
}): ProducedSource {
  const { producer, resource, name, param } = options;
  const rotation =
    options.rotation ?? `Rotate ${producer} to write a new value.`;
  let consumers = 0;
  if (getActiveResourceCollection()) {
    onEvaluationEnd(() => {
      if (consumers > 0) return;
      throw new Error(
        `No secret takes ${producer}.sources.${name}. Only the create of ${producer} gets the value, so the value would be lost. Declare a secret with it as the source, such as secret({ id: "...", source: <producer>.sources.${name} }).`,
      );
    });
  }
  return {
    "~producedSource": {
      producer,
      rotation,
      resource,
      register: (target) => {
        consumers += 1;
        resource.contribute({ [param]: target });
      },
    },
  };
}

// On globalThis, so that the infra bundle's copy of this package, the CLI's
// copy and the copy of a provider package that the resource registry loads
// share the stores.
const storesKey = Symbol.for("@notation/core/secret-stores");

function stores(): Map<string, SecretStore> {
  const holder = globalThis as { [storesKey]?: Map<string, SecretStore> };
  holder[storesKey] ??= new Map();
  return holder[storesKey];
}

/**
 * Registers the store implementation for the targets whose `provider` is
 * `provider`. A provider package calls it when the module of its secret
 * resource is loaded. It is an engine mechanism, not user-facing API.
 */
export function registerSecretStore(provider: string, store: SecretStore) {
  stores().set(provider, store);
}

function storeOf(target: SecretTarget): SecretStore {
  const store = stores().get(target.provider);
  if (!store) {
    throw new Error(
      `No secret store is registered for ${target.provider}. The package that provides it isn't loaded.`,
    );
  }
  return store;
}

/**
 * Writes each value to its target, in order. When a write fails, it deletes
 * the values that it wrote before, so that no target holds the value of a
 * create that failed. It then throws an error that says a target may now be
 * empty.
 */
export async function writeSecretValues(
  entries: [SecretTarget, string][],
): Promise<void> {
  for (const [, value] of entries) recordSecretValue(value);
  const written: SecretTarget[] = [];
  for (const [target, value] of entries) {
    try {
      await storeOf(target).write(target.params, value);
    } catch (error) {
      if (written.length === 0) throw error;
      await Promise.allSettled(written.map(deleteSecretValue));
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}. The values written to the other secrets before it were deleted, so a secret that held an earlier value may now be empty. The next plan shows each one as drift.`,
        { cause: error },
      );
    }
    written.push(target);
  }
}

export async function deleteSecretValue(target: SecretTarget): Promise<void> {
  await storeOf(target).delete(target.params);
}

export async function hasSecretValue(target: SecretTarget): Promise<boolean> {
  return storeOf(target).has(target.params);
}
