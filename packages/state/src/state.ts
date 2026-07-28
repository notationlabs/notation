export type StateNode = {
  /** The backing store's version of the record, counted from zero. */
  version: number;
  id: string;
  type: string;
  config: Record<string, unknown>;
  params: Record<string, unknown>;
  output: Record<string, unknown>;
  lastOperation: "create" | "update";
  lastOperationAt: string;
  [key: string]: unknown;
};

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

// Seeds and reads pass through JSON, so callers see what a persisted backend
// would return and cannot mutate the backend through a shared reference.
function cloneAsPersistedState(
  state: Record<string, StateNode>,
): Record<string, StateNode> {
  return JSON.parse(JSON.stringify(state)) as Record<string, StateNode>;
}
