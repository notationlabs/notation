import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateBackend } from "@notation/state";
import { SqliteStateBackend } from "@notation/state-sqlite";
import { createDefaultStateBackend } from "src/provisioner/state-backend";

describe("createDefaultStateBackend", () => {
  let directory: string;
  const originalStatePath = process.env.NOTATION_STATE_PATH;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "notation-state-"));
  });

  afterEach(() => {
    if (originalStatePath === undefined) {
      delete process.env.NOTATION_STATE_PATH;
    } else {
      process.env.NOTATION_STATE_PATH = originalStatePath;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses the file backend for the default JSON path", () => {
    delete process.env.NOTATION_STATE_PATH;

    expect(createDefaultStateBackend()).toBeInstanceOf(FileStateBackend);
  });

  it("uses the sqlite backend for .db paths", () => {
    process.env.NOTATION_STATE_PATH = path.join(directory, "state.db");

    const backend = createDefaultStateBackend();
    expect(backend).toBeInstanceOf(SqliteStateBackend);
    (backend as SqliteStateBackend).close();
  });

  it("uses the sqlite backend for .sqlite paths", () => {
    process.env.NOTATION_STATE_PATH = path.join(directory, "state.sqlite");

    const backend = createDefaultStateBackend();
    expect(backend).toBeInstanceOf(SqliteStateBackend);
    (backend as SqliteStateBackend).close();
  });

  it("creates missing parent directories for sqlite paths", () => {
    process.env.NOTATION_STATE_PATH = path.join(
      directory,
      ".notation",
      "state.db",
    );

    const backend = createDefaultStateBackend();
    expect(backend).toBeInstanceOf(SqliteStateBackend);
    (backend as SqliteStateBackend).close();
  });
});
