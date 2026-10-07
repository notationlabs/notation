import type { StateNode } from "@notation/state";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { PersistedResourceState } from "../operations";
import type { StoreClient } from "./yieldstar";

/**
 * Reads deployment state from outside a workflow, for the planner and for
 * anything reporting on a deployment. Read-only, but for one idempotent
 * create: state writes must be stamped with the workflow step that made them,
 * and this interface has nowhere to carry that step key, so any other write
 * made here would repeat on replay.
 */
export class DurableStateBackend {
  /** The deployment this backend belongs to; workflows and the deployment
   * hold key off this rather than carrying the ID separately. */
  readonly deploymentId: string;
  readonly #client: StoreClient;
  readonly #prefix: string;

  constructor(client: StoreClient, deploymentId: string) {
    this.deploymentId = deploymentId;
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

  /**
   * Creates a resource's record unless one exists. Repeating it is harmless,
   * which is what makes it the one write allowed here; a workflow still runs
   * it as a step, so that a replay does not repeat it.
   */
  async createIfAbsent(
    id: string,
    initial: PersistedResourceState,
  ): Promise<void> {
    await this.#client.getOrCreateStore({
      definition: resourceStateStore,
      id: this.storeId(id),
      initial,
    });
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

  // getStore throws for a missing store, and the error is indistinguishable
  // from a real failure, so absence is confirmed by listing.
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
