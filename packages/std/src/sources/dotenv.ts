import fs from "node:fs/promises";
import { parseEnv } from "node:util";
import { fromProjectRoot, Redacted, type Source } from "@notation/core";
import { isErrorWithCode } from "@notation/utils";

/**
 * Reads secret values from a `.env` file. `path` is relative to the project
 * root. A missing file counts as empty.
 */
export function dotenv(path: string): Source {
  const read = async (): Promise<Record<string, string | undefined>> => {
    try {
      return parseEnv(await fs.readFile(fromProjectRoot(path), "utf8"));
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) return {};
      throw error;
    }
  };
  return {
    name: "dotenv",
    has: async (key) => Object.hasOwn(await read(), key),
    get: async (key) => {
      const value = (await read())[key];
      if (value === undefined) {
        throw new Error(`\`${key}\` isn't in ${path}.`);
      }
      return new Redacted(value);
    },
  };
}
