import { defineCommand } from "@pokit/core";

// What CI and the pre-commit hook call.
export const command = defineCommand({
  label: "Run the suite once",
  run: async (r) => {
    await r.exec("vitest run");
  },
});
