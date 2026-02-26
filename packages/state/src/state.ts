import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type StateNode = {
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
  has(id: string): Promise<boolean>;
  update(id: string, patch: Partial<StateNode>): Promise<void>;
  delete(id: string): Promise<void>;
  values(): Promise<StateNode[]>;
};

export type State = StateBackend;

export class MemoryStateBackend implements StateBackend {
  #state: Record<string, StateNode>;

  constructor(initialState: Record<string, StateNode> = {}) {
    this.#state = cloneAsPersistedState(initialState);
  }

  async get(id: string): Promise<StateNode | undefined> {
    const state = await this.readState();
    return state[id];
  }

  async has(id: string): Promise<boolean> {
    const state = await this.readState();
    return id in state;
  }

  async update(id: string, patch: Partial<StateNode>): Promise<void> {
    const state = await this.readState();
    state[id] = {
      ...state[id],
      ...patch,
    } as StateNode;
    await this.writeState(state);
  }

  async delete(id: string): Promise<void> {
    const state = await this.readState();
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

export class FileStateBackend implements StateBackend {
  constructor(private readonly stateFilePath: string) {}

  async get(id: string): Promise<StateNode | undefined> {
    const state = await this.readState();
    return state[id];
  }

  async has(id: string): Promise<boolean> {
    const state = await this.readState();
    return id in state;
  }

  async update(id: string, patch: Partial<StateNode>): Promise<void> {
    const state = await this.readState();
    state[id] = {
      ...state[id],
      ...patch,
    } as StateNode;
    await this.writeState(state);
  }

  async delete(id: string): Promise<void> {
    const state = await this.readState();
    delete state[id];
    await this.writeState(state);
  }

  async values(): Promise<StateNode[]> {
    const state = await this.readState();
    return Object.values(state);
  }

  private async readState(): Promise<Record<string, StateNode>> {
    try {
      const file = await readFile(this.stateFilePath, "utf8");
      return JSON.parse(file) as Record<string, StateNode>;
    } catch (error) {
      if (isFileMissingError(error)) {
        return {};
      }

      throw error;
    }
  }

  private async writeState(state: Record<string, StateNode>): Promise<void> {
    const directory = path.dirname(this.stateFilePath);
    await mkdir(directory, { recursive: true });

    const tempFilePath = path.join(
      directory,
      `${path.basename(this.stateFilePath)}.${process.pid}.${Date.now()}.tmp`,
    );

    const serialized = `${JSON.stringify(state, null, 2)}\n`;

    await writeFile(tempFilePath, serialized, "utf8");

    try {
      await rename(tempFilePath, this.stateFilePath);
    } catch (error) {
      await unlink(tempFilePath).catch(() => undefined);
      throw error;
    }
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function cloneAsPersistedState(
  state: Record<string, StateNode>,
): Record<string, StateNode> {
  return JSON.parse(JSON.stringify(state)) as Record<string, StateNode>;
}
