import { Redacted } from "@notation/core";
import type { Source } from "./types";

/**
 * Source reading secret values from `process.env`.
 */
export const env: Source = {
  name: "env",
  async has(key) {
    return process.env[key] !== undefined;
  },
  async get(key) {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Environment variable "${key}" is not set.`);
    }
    return new Redacted(value);
  },
};
