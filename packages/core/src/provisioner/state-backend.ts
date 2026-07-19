import { FileStateBackend, type StateBackend } from "@notation/state";
import { SqliteStateBackend } from "@notation/state-sqlite";

export const DEFAULT_STATE_PATH = "./.notation/state.json";

export function resolveStatePath(): string {
  return process.env.NOTATION_STATE_PATH ?? DEFAULT_STATE_PATH;
}

export function createDefaultStateBackend(): StateBackend {
  const statePath = resolveStatePath();
  if (statePath.endsWith(".db") || statePath.endsWith(".sqlite")) {
    return new SqliteStateBackend(statePath);
  }
  return new FileStateBackend(statePath);
}
