import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LeaseConflict,
  RevConflict,
  type Lease,
  type StateBackend,
  type StateNode,
} from "@notation/state";

export class SqliteStateBackend implements StateBackend {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        rev INTEGER NOT NULL,
        value TEXT NOT NULL
      )
    `);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS resource_leases (
        scope TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  close(): void {
    this.#database.close();
  }

  async get(id: string): Promise<StateNode | undefined> {
    const row = this.#database
      .prepare("SELECT value FROM resources WHERE id = ?")
      .get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as StateNode) : undefined;
  }

  async has(id: string): Promise<boolean> {
    return Boolean(
      this.#database
        .prepare("SELECT 1 FROM resources WHERE id = ?")
        .get(id),
    );
  }

  async update(
    id: string,
    expectedRev: number,
    patch: Partial<StateNode>,
  ): Promise<{ rev: number }> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.get(id);
      // A missing record counts as rev 0, so expectedRev: 0 = "must not exist".
      if ((current?.rev ?? 0) !== expectedRev) {
        throw new RevConflict(id, expectedRev, current?.rev);
      }

      const rev = (current?.rev ?? 0) + 1;
      const node = { ...current, ...patch, rev } as StateNode;
      if (current) {
        const result = this.#database
          .prepare(
            "UPDATE resources SET rev = ?, value = ? WHERE id = ? AND rev = ?",
          )
          .run(rev, JSON.stringify(node), id, current.rev);
        if (result.changes !== 1) {
          const actual = await this.get(id);
          throw new RevConflict(id, current.rev, actual?.rev);
        }
      } else {
        this.#database
          .prepare(
            "INSERT INTO resources (id, rev, value) VALUES (?, ?, ?)",
          )
          .run(id, rev, JSON.stringify(node));
      }
      this.#database.exec("COMMIT");
      return { rev };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async delete(id: string, expectedRev: number): Promise<void> {
    const current = await this.get(id);
    if ((current?.rev ?? 0) !== expectedRev) {
      throw new RevConflict(id, expectedRev, current?.rev);
    }
    if (!current) return;

    const result = this.#database
      .prepare("DELETE FROM resources WHERE id = ? AND rev = ?")
      .run(id, current.rev);
    if (result.changes !== 1) {
      const actual = await this.get(id);
      throw new RevConflict(id, current.rev, actual?.rev);
    }
  }

  async values(): Promise<StateNode[]> {
    const rows = this.#database
      .prepare("SELECT value FROM resources ORDER BY id")
      .all() as { value: string }[];
    return rows.map(({ value }) => JSON.parse(value) as StateNode);
  }

  async lease(scope: string, ttl: number): Promise<Lease> {
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError(
        "Lease TTL must be a positive number of milliseconds",
      );
    }

    const owner = randomUUID();
    const expiresAtMs = Date.now() + ttl;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "DELETE FROM resource_leases WHERE scope = ? AND expires_at <= ?",
        )
        .run(scope, Date.now());
      const current = this.#database
        .prepare("SELECT expires_at FROM resource_leases WHERE scope = ?")
        .get(scope) as { expires_at: number } | undefined;
      if (current) {
        throw new LeaseConflict(
          scope,
          new Date(current.expires_at).toISOString(),
        );
      }
      this.#database
        .prepare(
          "INSERT INTO resource_leases (scope, owner, expires_at) VALUES (?, ?, ?)",
        )
        .run(scope, owner, expiresAtMs);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    let released = false;
    let currentExpiresAtMs = expiresAtMs;
    return {
      scope,
      get expiresAt() {
        return new Date(currentExpiresAtMs).toISOString();
      },
      renew: async (nextTtl) => {
        if (!Number.isFinite(nextTtl) || nextTtl <= 0) {
          throw new RangeError(
            "Lease TTL must be a positive number of milliseconds",
          );
        }
        const now = Date.now();
        const nextExpiresAtMs = now + nextTtl;
        const result = this.#database
          .prepare(
            "UPDATE resource_leases SET expires_at = ? WHERE scope = ? AND owner = ? AND expires_at > ?",
          )
          .run(nextExpiresAtMs, scope, owner, now);
        if (result.changes !== 1) {
          const current = this.#database
            .prepare("SELECT expires_at FROM resource_leases WHERE scope = ?")
            .get(scope) as { expires_at: number } | undefined;
          throw new LeaseConflict(
            scope,
            new Date(current?.expires_at ?? 0).toISOString(),
          );
        }
        currentExpiresAtMs = nextExpiresAtMs;
        return new Date(nextExpiresAtMs).toISOString();
      },
      release: async () => {
        if (released) return;
        this.#database
          .prepare("DELETE FROM resource_leases WHERE scope = ? AND owner = ?")
          .run(scope, owner);
        released = true;
      },
    };
  }
}
