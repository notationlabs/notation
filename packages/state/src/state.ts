import { RevConflict } from "./conflicts";

export type StateNode = {
  rev: number;
  id: string;
  type: string;
  config: Record<string, unknown>;
  params: Record<string, unknown>;
  output: Record<string, unknown>;
  lastOperation: "drift" | "create" | "update" | "delete";
  lastOperationAt: string;
  [key: string]: unknown;
};

export interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  /**
   * The stored revision must match expectedRev. A missing record counts as
   * revision 0, so expectedRev: 0 asserts that the record does not exist yet.
   */
  update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }>;
  delete(id: string, expectedRev: number): Promise<void>;
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

  async update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }> {
    const state = await this.readState();
    assertExpectedRev(id, state[id], expectedRev);
    const rev = (state[id]?.rev ?? 0) + 1;
    state[id] = {
      ...state[id],
      ...patch,
      rev,
    } as StateNode;
    await this.writeState(state);
    return { rev };
  }

  async delete(id: string, expectedRev: number): Promise<void> {
    const state = await this.readState();
    assertExpectedRev(id, state[id], expectedRev);
    delete state[id];
    await this.writeState(state);
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

  private async writeState(state: Record<string, StateNode>): Promise<void> {
    this.#state = cloneAsPersistedState(state);
  }
}

// A missing record counts as rev 0, so expectedRev: 0 means "must not exist".
function assertExpectedRev(
  id: string,
  node: StateNode | undefined,
  expectedRev: number,
): void {
  if ((node?.rev ?? 0) !== expectedRev) {
    throw new RevConflict(id, expectedRev, node?.rev);
  }
}

function cloneAsPersistedState(
  state: Record<string, StateNode>,
): Record<string, StateNode> {
  return JSON.parse(JSON.stringify(state)) as Record<string, StateNode>;
}
