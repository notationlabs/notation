import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Redacted } from "@notation/core";
import { fromProjectRoot } from "@notation/core/paths";
import { isErrorWithCode } from "@notation/utils";
import type { Source } from "./types";

async function readDotenvFile(filePath: string): Promise<NodeJS.Dict<string>> {
  const resolved = fromProjectRoot(filePath);
  try {
    const content = await readFile(resolved, "utf8");
    return parseEnv(content);
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

/**
 * Source reading key/value pairs from a dotenv file resolved relative to the
 * project root. A missing file counts as empty.
 */
export function dotenv(filePath: string): Source {
  return {
    name: "dotenv",
    async has(key) {
      const entries = await readDotenvFile(filePath);
      return Object.hasOwn(entries, key);
    },
    async get(key) {
      const entries = await readDotenvFile(filePath);
      if (!Object.hasOwn(entries, key)) {
        throw new Error(`Key "${key}" is not in ${filePath}.`);
      }
      return new Redacted(entries[key]!);
    },
  };
}
