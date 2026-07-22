import { RevConflict, type StateNode } from "@notation/state";
import { randomUUID } from "node:crypto";
import {
  RESOURCE_CREATION_TOKEN,
  resourceStateStore,
  toStateNode,
  withoutRev,
  type StoredResourceState,
} from "./stores";
import type { StoreClient } from "./yieldstar";

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
      const creationToken = randomUUID();
      const initial = {
        ...patch,
        id,
        [RESOURCE_CREATION_TOKEN]: creationToken,
      } as StoredResourceState;
      const created = await this.#client.getOrCreateStore({
        definition: resourceStateStore,
        id: storeId,
        initial,
      });
      if (created.state[RESOURCE_CREATION_TOKEN] !== creationToken) {
        throw new RevConflict(id, expectedRev, created.version + 1);
      }
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
    if (!result.updated)
      throw new RevConflict(id, expectedRev, result.actualVersion + 1);
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
    if (!result.deleted)
      throw new RevConflict(
        id,
        expectedRev,
        result.reason === "conflict" ? result.actualVersion + 1 : undefined,
      );
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
    const scopedIds = ids.filter((id) => id.startsWith(this.#prefix));
    const snapshots = await Promise.all(
      scopedIds.map((id) => this.#tryGetSnapshot(id)),
    );
    await Promise.all(
      scopedIds.map(async (id, index) => {
        const snapshot = snapshots[index];
        if (!snapshot) return;
        const result = await this.#client.deleteStoreFrom({
          definition: resourceStateStore,
          id,
          snapshot,
        });
        if (!result.deleted && result.reason === "conflict") {
          throw new RevConflict(
            id.slice(this.#prefix.length),
            snapshot.version + 1,
            result.actualVersion + 1,
          );
        }
      }),
    );
  }
}
