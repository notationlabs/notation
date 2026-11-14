import { Redacted, type Source } from "@notation/core";

/** Reads secret values from `process.env`. */
export const env: Source = {
  name: "env",
  has: async (key) => Boolean(process.env[key]),
  get: async (key) => {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`\`${key}\` isn't set in the environment.`);
    }
    return new Redacted(value);
  },
};
