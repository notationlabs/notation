import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RevConflict,
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
      this.#database.prepare("SELECT 1 FROM resources WHERE id = ?").get(id),
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
          .prepare("INSERT INTO resources (id, rev, value) VALUES (?, ?, ?)")
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
}
