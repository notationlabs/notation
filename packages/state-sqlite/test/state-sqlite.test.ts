import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateBackend } from "../src";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

async function createBackend() {
  const directory = await mkdtemp(path.join(tmpdir(), "notation-sqlite-"));
  const backend = new SqliteStateBackend(path.join(directory, "state.db"));
  cleanups.push(async () => {
    backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  return backend;
}

describe("SqliteStateBackend", () => {
  it("persists revisions and enforces compare-and-swap", async () => {
    const backend = await createBackend();
    await expect(
      backend.update("service", 0, {
        id: "service",
        type: "test/service/main",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-15T00:00:00.000Z",
      }),
    ).resolves.toEqual({ rev: 1 });
    await expect(
      backend.update("service", 1, { output: { ready: true } }),
    ).resolves.toEqual({
      rev: 2,
    });
    await expect(backend.delete("service", 1)).rejects.toMatchObject({
      name: "RevConflict",
      actualRev: 2,
    });
  });

  it("coordinates leases across backend instances and releases by owner", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "notation-sqlite-lease-"),
    );
    const databasePath = path.join(directory, "state.db");
    const first = new SqliteStateBackend(databasePath);
    const second = new SqliteStateBackend(databasePath);
    cleanups.push(async () => {
      first.close();
      second.close();
      await rm(directory, { recursive: true, force: true });
    });

    const lease = await first.lease("orphans", 10_000);
    await expect(second.lease("orphans", 10_000)).rejects.toMatchObject({
      name: "LeaseConflict",
      scope: "orphans",
    });
    const firstExpiry = lease.expiresAt;
    await lease.renew(20_000);
    expect(lease.expiresAt).not.toBe(firstExpiry);
    await lease.release();
    const nextLease = await second.lease("orphans", 10_000);
    expect(nextLease).toMatchObject({ scope: "orphans" });
    await nextLease.release();
  });

  it("waits for a concurrent writer instead of raising database locked", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "notation-sqlite-busy-"),
    );
    const databasePath = path.join(directory, "state.db");
    const backend = new SqliteStateBackend(databasePath);
    cleanups.push(async () => {
      backend.close();
      await rm(directory, { recursive: true, force: true });
    });

    const blocker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { DatabaseSync } from "node:sqlite";
          const database = new DatabaseSync(process.argv[1]);
          database.exec("BEGIN IMMEDIATE");
          process.stdout.write("locked\\n");
          setTimeout(() => {
            database.exec("ROLLBACK");
            database.close();
          }, 100);
        `,
        databasePath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const blockerExited = once(blocker, "exit");
    await once(blocker.stdout!, "data");

    await expect(
      backend.update("service", 0, {
        id: "service",
        type: "test/service/main",
        config: {},
        params: {},
        output: {},
        lastOperation: "create",
        lastOperationAt: "2026-07-15T00:00:00.000Z",
      }),
    ).resolves.toEqual({ rev: 1 });
    await blockerExited;
  });
});
