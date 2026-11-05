import { defineCommand } from "@pokit/core";

// What CI calls.
export const command = defineCommand({
  label: "Run the suite once",
  run: async (r) => {
    await r.exec("pnpm exec vitest run");
  },
});
