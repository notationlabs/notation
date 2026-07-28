import type { StateNode } from "@notation/state";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { StoreClient } from "./yieldstar";

/**
 * Reads deployment state from outside a workflow, for the planner and for
 * anything reporting on a deployment.
 *
 * Deliberately read-only. Writes belong to the workflow, which makes them
 * through the store handle so they are stamped with the step that made them.
 * There is nowhere on this interface to carry that idempotency key, so a
 * write made here would be repeated on replay rather than recognised.
 */
export class DurableStateBackend {
  readonly #client: StoreClient;
  readonly #prefix: string;

  constructor(client: StoreClient, deploymentId: string) {
    this.#client = client;
    // Keep deployment prefixes disjoint so orphan cleanup cannot delete
    // another deployment's stores.
    this.#prefix = `${encodeURIComponent(deploymentId)}:`;
  }

  storeId(resourceId: string) {
    return `${this.#prefix}${resourceId}`;
  }

  async get(id: string): Promise<StateNode | undefined> {
    const snapshot = await this.snapshot(id);
    return snapshot ? toStateNode(snapshot) : undefined;
  }

  snapshot(id: string): Promise<ResourceSnapshot | undefined> {
    return this.#read(this.storeId(id));
  }

  async values(): Promise<StateNode[]> {
    const ids = await this.#client.listStores(resourceStateStore);
    const snapshots = await Promise.all(
      ids
        .filter((id) => id.startsWith(this.#prefix))
        .map((id) => this.#read(id)),
    );
    return snapshots
      .filter((snapshot) => snapshot !== undefined)
      .map(toStateNode);
  }

  // getStore throws for a store that does not exist rather than returning
  // undefined, and the error is not distinguishable from a real failure, so
  // absence is confirmed by listing. Kept here so no caller has to know that.
  async #read(storeId: string): Promise<ResourceSnapshot | undefined> {
    try {
      return await this.#client.getStore({
        definition: resourceStateStore,
        id: storeId,
      });
    } catch (error) {
      const ids = await this.#client.listStores(resourceStateStore);
      if (!ids.includes(storeId)) return undefined;
      throw error;
    }
  }
}
