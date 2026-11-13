import fs from "node:fs/promises";
import { fromProjectRoot, Redacted, type Source } from "@notation/core";
import { isErrorWithCode } from "@notation/utils";

/**
 * Reads secret values from a `.env` file. `path` is relative to the project
 * root. A missing file counts as empty.
 */
export function dotenv(path: string): Source {
  const read = async () => {
    try {
      return parseDotenv(await fs.readFile(fromProjectRoot(path), "utf8"));
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) return new Map<string, string>();
      throw error;
    }
  };
  return {
    name: "dotenv",
    has: async (key) => (await read()).has(key),
    get: async (key) => {
      const value = (await read()).get(key);
      if (value === undefined) {
        throw new Error(`\`${key}\` isn't in ${path}.`);
      }
      return new Redacted(value);
    },
  };
}

const line =
  /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\n]*)?[ \t]*(?:#.*)?$/gm;

/**
 * Parses the lines `KEY=value` of a `.env` file. A value can be quoted with
 * `'`, `"` or a backtick, and a quoted value can span lines. A double-quoted
 * value turns `\n` and `\r` into line breaks. An unquoted value ends at `#`,
 * and its surrounding spaces are dropped. A later line overrides an earlier
 * one with the same key.
 */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(line)) {
    const key = match[1]!;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === "'" || quote === '"' || quote === "`") &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    }
    values.set(key, value);
  }
  return values;
}
