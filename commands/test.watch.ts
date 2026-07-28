import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Re-run tests on change",
  run: async (r) => {
    await r.exec("vitest watch");
  },
});
