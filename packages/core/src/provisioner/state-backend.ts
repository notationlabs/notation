import { FileStateBackend, type StateBackend } from "@notation/state";

export const DEFAULT_STATE_PATH = "./.notation/state.json";

export function resolveStatePath(): string {
  return process.env.NOTATION_STATE_PATH ?? DEFAULT_STATE_PATH;
}

export function createDefaultStateBackend(): StateBackend {
  return new FileStateBackend(resolveStatePath());
}
