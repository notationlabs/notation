import type { StateNode } from "@notation/state";
import {
  resourceStateStore,
  toStateNode,
  type ResourceSnapshot,
} from "./stores";
import type { StoreClient } from "./yieldstar";

/**
 * Reads deployment state from outside a workflow, for the planner and for
 * anything reporting on a deployment. A read of a resource with no record
 * creates its store with `null` state, which records nothing. Every other
 * write goes through a workflow step, which stamps the write with its step
 * key so that a replay does not repeat it.
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
    return toStateNode(await this.snapshot(id));
  }

  /** The snapshot's state is `null` when the resource has no record. */
  snapshot(id: string): Promise<ResourceSnapshot> {
    return this.#read(this.storeId(id));
  }

  async values(): Promise<StateNode[]> {
    const ids = await this.#client.listStores(resourceStateStore);
    const snapshots = await Promise.all(
      ids
        .filter((id) => id.startsWith(this.#prefix))
        .map((id) => this.#read(id)),
    );
    return snapshots.map(toStateNode).filter((node) => node !== undefined);
  }

  #read(storeId: string): Promise<ResourceSnapshot> {
    return this.#client.store(resourceStateStore, storeId).get();
  }
}
