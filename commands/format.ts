import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Format the repository",
  run: async (r) => {
    await r.exec("prettier --write .");
  },
});
