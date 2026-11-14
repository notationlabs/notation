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

/** Writes secret values in one kind of store. */
export type SecretStore = {
  /** Creates the secret, or overwrites the value of the one that exists. */
  write(params: Record<string, unknown>, value: string): Promise<void>;
};

/**
 * A value that a resource gets only once, in the response to its create,
 * such as the value of an API token. A resource's construct may expose a
 * produced source for a secret to take, and `accountToken()` keeps its own
 * internal. One secret takes it as its `source`, and the resource's create
 * writes the value to that secret's target. Deploy can't ask it for a
 * value, so it is not a `Source`.
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
    /** The resource whose create writes the value. The secret depends on it. */
    resource: BaseResource;
    /**
     * Sets the target that the producer's create writes the value to. A
     * secret calls it when it is constructed. It throws when another secret
     * already took the source.
     */
    register(
      target: SecretTarget,
      /** Names the secret's declaration, such as `secret({ id: "key" })`. */
      consumer: string,
    ): void;
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
 * Makes the produced source `name` of `resource`. The target that a secret
 * registers is contributed to the collected param `param` of `resource`.
 * Output refs in the target make `resource` depend on the resources they
 * refer to, such as the store. A second secret that registers a target
 * throws. When evaluation ends, it throws if no secret takes the source, as
 * the value would be lost. It is an engine mechanism for resource packages,
 * not user-facing API.
 */
export function producedSource(options: {
  producer: string;
  resource: BaseResource;
  /** The name in `sources`, such as `value`. */
  name: string;
  /**
   * A collected param of `resource` that holds one `SecretTarget`. Its
   * `collect` returns the one item, as `register` accepts only one target.
   * Make it immutable: only a create gets a value to write to a new target.
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
  let consumer: string | undefined;
  if (getActiveResourceCollection()) {
    onEvaluationEnd(() => {
      if (consumer !== undefined) return;
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
      register: (target, by) => {
        if (consumer !== undefined) {
          throw new Error(
            `${by} can't take ${producer}.sources.${name}, because ${consumer} takes it. Only one secret can take a produced source.`,
          );
        }
        consumer = by;
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
 * Writes the value to the target. It first adds the value to the values that
 * the reconciler removes from errors, as a store can echo it in an error.
 */
export async function writeSecretValue(
  target: SecretTarget,
  value: string,
): Promise<void> {
  recordSecretValue(value);
  await storeOf(target).write(target.params, value);
}
