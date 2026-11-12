import type { DurableObject, DurableValue } from "@notation/resource";

export type StateNode = {
  /**
   * The backing store's version of the record. The store exists at version 0
   * before the record is written, so a new record is version 1.
   */
  version: number;
  id: string;
  type: string;
  provider: string;
  config: DurableObject;
  params: DurableObject;
  output: DurableObject;
  /**
   * The IDs of the resources this one depends on, sorted. Absent on a record
   * written before edges were recorded.
   */
  dependsOn?: string[];
  /**
   * `creating` marks a record written before a create is attempted. It is
   * evidence that Notation tried to create the resource, so a later deploy
   * may take over a resource the provider reports as already existing. Its
   * output holds only the key fields that params supply.
   */
  lastOperation: "creating" | "create" | "update";
  lastOperationAt: string;
  /**
   * Set only on a "creating" record: the IDs of the executions whose creates
   * may have made the resource. It lists every execution that wrote the
   * record. An execution's create token is derived from its ID and the
   * resource's ID, so deploy can recompute it. Deploy ignores the field on
   * any other record.
   */
  creates?: string[];
  [key: string]: DurableValue;
};

// The predicate names the "creating" operation, so that a false result
// leaves `node` as a record with another operation, not as undefined.
export function isCreatingRecord(
  node: StateNode | undefined,
): node is StateNode & { lastOperation: "creating" } {
  return node?.lastOperation === "creating";
}

/**
 * Read-only: state writes happen inside the durable workflow, through the
 * store handle, so each write is stamped with the step that made it.
 */
export interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  values(): Promise<StateNode[]>;
}

export class MemoryStateBackend implements StateBackend {
  #state: Record<string, StateNode>;

  constructor(initialState: Record<string, StateNode> = {}) {
    this.#state = cloneAsPersistedState(initialState);
  }

  async get(id: string): Promise<StateNode | undefined> {
    const state = await this.readState();
    return state[id];
  }

  async values(): Promise<StateNode[]> {
    const state = await this.readState();
    return Object.entries(state)
      .sort(([leftId], [rightId]) => {
        if (leftId < rightId) {
          return -1;
        }

        if (leftId > rightId) {
          return 1;
        }

        return 0;
      })
      .map(([, value]) => value);
  }

  private async readState(): Promise<Record<string, StateNode>> {
    return cloneAsPersistedState(this.#state);
  }
}

// Seeds and reads are cloned, so callers cannot mutate the backend through a
// shared reference.
function cloneAsPersistedState(
  state: Record<string, StateNode>,
): Record<string, StateNode> {
  return structuredClone(state);
}
