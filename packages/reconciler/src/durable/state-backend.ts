import { RevConflict, type StateNode } from "@notation/state";
import {
  resourceStateStore,
  toStateNode,
  withoutRev,
  type StoredResourceState,
} from "./stores";
import type { StoreClient } from "./yieldstar";

export class DurableStateBackend {
  readonly #client: StoreClient;
  readonly #deploymentId: string;
  readonly #prefix: string;

  constructor(client: StoreClient, deploymentId: string) {
    this.#client = client;
    this.#deploymentId = deploymentId;
    // Keep deployment prefixes disjoint so orphan cleanup cannot delete
    // another deployment's stores.
    this.#prefix = `${encodeURIComponent(deploymentId)}:`;
  }

  storeId(resourceId: string) {
    return `${this.#prefix}${resourceId}`;
  }

  async get(id: string): Promise<StateNode | undefined> {
    const snapshot = await this.#tryGetSnapshot(this.storeId(id));
    return snapshot ? toStateNode(snapshot) : undefined;
  }

  async #tryGetSnapshot(
    storeId: string,
  ): Promise<
    | { state: StoredResourceState; instanceId: string; version: number }
    | undefined
  > {
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

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }> {
    const storeId = this.storeId(id);
    const snapshot = await this.#tryGetSnapshot(storeId);
    if (!snapshot) {
      if (expectedRev !== 0) throw new RevConflict(id, expectedRev, undefined);
      const initial = { ...patch, id } as StoredResourceState;
      const created = await this.#client.getOrCreateStore({
        definition: resourceStateStore,
        id: storeId,
        initial,
      });
      return { rev: created.version + 1 };
    }

    const actualRev = snapshot.version + 1;
    if (actualRev !== expectedRev)
      throw new RevConflict(id, expectedRev, actualRev);
    const result = await this.#client.updateStoreFrom({
      definition: resourceStateStore,
      id: storeId,
      snapshot,
      updater: (draft) => {
        Object.assign(draft, withoutRev(patch));
      },
    });
    if (!result.updated) throw new RevConflict(id, expectedRev, undefined);
    return { rev: result.version + 1 };
  }

  async delete(id: string, expectedRev: number): Promise<void> {
    const storeId = this.storeId(id);
    const snapshot = await this.#tryGetSnapshot(storeId);
    if (!snapshot) {
      if (expectedRev !== 0) throw new RevConflict(id, expectedRev, undefined);
      return;
    }
    const actualRev = snapshot.version + 1;
    if (actualRev !== expectedRev)
      throw new RevConflict(id, expectedRev, actualRev);
    const result = await this.#client.deleteStoreFrom({
      definition: resourceStateStore,
      id: storeId,
      snapshot,
    });
    if (!result.deleted) throw new RevConflict(id, expectedRev, undefined);
  }

  async values(): Promise<StateNode[]> {
    const ids = await this.#client.listStores(resourceStateStore);
    const snapshots = await Promise.all(
      ids
        .filter((id) => id.startsWith(this.#prefix))
        .map((id) => this.#tryGetSnapshot(id)),
    );
    return snapshots
      .filter((snapshot) => snapshot !== undefined)
      .map(toStateNode);
  }

  snapshot(id: string) {
    return this.#client.getStore({
      definition: resourceStateStore,
      id: this.storeId(id),
    });
  }

  async clear(): Promise<void> {
    const ids = await this.#client.listStores(resourceStateStore);
    await Promise.all(
      ids
        .filter((id) => id.startsWith(this.#prefix))
        .map((id) =>
          this.#client.deleteStore({
            definition: resourceStateStore,
            id,
          }),
        ),
    );
  }
}
