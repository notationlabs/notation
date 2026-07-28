import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build all packages",
  run: async (r) => {
    await r.exec("turbo run build");
  },
});
