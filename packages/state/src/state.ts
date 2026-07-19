import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LeaseConflict, RevConflict } from "./conflicts";

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
  has(id: string): Promise<boolean>;
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
  lease(scope: string, ttl: number): Promise<Lease>;
}

export interface Lease {
  readonly scope: string;
  readonly expiresAt: string;
  renew(ttl: number): Promise<string>;
  release(): Promise<void>;
}

export type State = StateBackend;

export class MemoryStateBackend implements StateBackend {
  #state: Record<string, StateNode>;
  #leases = new Map<string, { owner: string; expiresAtMs: number }>();

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

  async lease(scope: string, ttl: number): Promise<Lease> {
    assertLeaseTtl(ttl);
    const now = Date.now();
    const current = this.#leases.get(scope);
    if (current && current.expiresAtMs > now) {
      throw new LeaseConflict(
        scope,
        new Date(current.expiresAtMs).toISOString(),
      );
    }

    const owner = randomUUID();
    let expiresAtMs = now + ttl;
    this.#leases.set(scope, { owner, expiresAtMs });

    return {
      scope,
      get expiresAt() {
        return new Date(expiresAtMs).toISOString();
      },
      renew: async (nextTtl) => {
        assertLeaseTtl(nextTtl);
        const held = this.#leases.get(scope);
        if (!held || held.owner !== owner || held.expiresAtMs <= Date.now()) {
          throw new LeaseConflict(
            scope,
            new Date(held?.expiresAtMs ?? 0).toISOString(),
          );
        }
        expiresAtMs = Date.now() + nextTtl;
        held.expiresAtMs = expiresAtMs;
        return new Date(expiresAtMs).toISOString();
      },
      release: async () => {
        if (this.#leases.get(scope)?.owner === owner)
          this.#leases.delete(scope);
      },
    };
  }

  private async readState(): Promise<Record<string, StateNode>> {
    return cloneAsPersistedState(this.#state);
  }

  private async writeState(state: Record<string, StateNode>): Promise<void> {
    this.#state = cloneAsPersistedState(state);
  }
}

const FILE_LOCK_STALE_MS = 10_000;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_RETRY_MS = 25;

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

  async update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }> {
    return this.withLock(async () => {
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
    });
  }

  async delete(id: string, expectedRev: number): Promise<void> {
    await this.withLock(async () => {
      const state = await this.readState();
      assertExpectedRev(id, state[id], expectedRev);
      delete state[id];
      await this.writeState(state);
    });
  }

  async values(): Promise<StateNode[]> {
    const state = await this.readState();
    return Object.values(state);
  }

  async lease(scope: string, ttl: number): Promise<Lease> {
    assertLeaseTtl(ttl);
    const leaseFilePath = `${this.stateFilePath}.${encodeURIComponent(scope)}.lease`;
    const owner = randomUUID();
    let expiresAtMs: number;
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });

    for (;;) {
      expiresAtMs = Date.now() + ttl;
      try {
        await writeFile(leaseFilePath, JSON.stringify({ owner, expiresAtMs }), {
          flag: "wx",
        });
        break;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const current = await readFileLease(leaseFilePath);
        if (!current || current.expiresAtMs <= Date.now()) {
          await unlink(leaseFilePath).catch(() => undefined);
          continue;
        }
        throw new LeaseConflict(
          scope,
          new Date(current.expiresAtMs).toISOString(),
        );
      }
    }

    return {
      scope,
      get expiresAt() {
        return new Date(expiresAtMs).toISOString();
      },
      renew: async (nextTtl) => {
        assertLeaseTtl(nextTtl);
        const current = await readFileLease(leaseFilePath);
        if (
          !current ||
          current.owner !== owner ||
          current.expiresAtMs <= Date.now()
        ) {
          throw new LeaseConflict(
            scope,
            new Date(current?.expiresAtMs ?? 0).toISOString(),
          );
        }
        expiresAtMs = Date.now() + nextTtl;
        await writeFile(leaseFilePath, JSON.stringify({ owner, expiresAtMs }));
        return new Date(expiresAtMs).toISOString();
      },
      release: async () => {
        const current = await readFileLease(leaseFilePath);
        if (current?.owner === owner) {
          await unlink(leaseFilePath).catch(() => undefined);
        }
      },
    };
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

  /**
   * The read-check-write in update/delete is only safe if no other process
   * interleaves, so writers hold an exclusive lock file. A lock older than
   * FILE_LOCK_STALE_MS is treated as abandoned by a crashed process.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockFilePath = `${this.stateFilePath}.lock`;
    await mkdir(path.dirname(this.stateFilePath), { recursive: true });

    const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await writeFile(
          lockFilePath,
          JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
          { flag: "wx" },
        );
        break;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
        const lockStat = await stat(lockFilePath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > FILE_LOCK_STALE_MS) {
          await unlink(lockFilePath).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out acquiring state lock at ${lockFilePath}; delete it if no other deploy is running`,
          );
        }
        await sleep(FILE_LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await unlink(lockFilePath).catch(() => undefined);
    }
  }

  private async writeState(state: Record<string, StateNode>): Promise<void> {
    const directory = path.dirname(this.stateFilePath);
    await mkdir(directory, { recursive: true });

    const tempFilePath = path.join(
      directory,
      `${path.basename(this.stateFilePath)}.${randomUUID()}.tmp`,
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

function assertLeaseTtl(ttl: number): void {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError("Lease TTL must be a positive number of milliseconds");
  }
}

type FileLeaseRecord = { owner: string; expiresAtMs: number };

async function readFileLease(
  filePath: string,
): Promise<FileLeaseRecord | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as FileLeaseRecord;
  } catch (error) {
    if (isFileMissingError(error) || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}

function isFileMissingError(error: unknown): boolean {
  return isErrorWithCode(error, "ENOENT");
}

function isFileExistsError(error: unknown): boolean {
  return isErrorWithCode(error, "EEXIST");
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function cloneAsPersistedState(
  state: Record<string, StateNode>,
): Record<string, StateNode> {
  return JSON.parse(JSON.stringify(state)) as Record<string, StateNode>;
}
