import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Watch and rebuild every package",
  run: async (r) => {
    await r.exec("turbo run dev --concurrency=20");
  },
});
