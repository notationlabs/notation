import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Publish to npm",
  run: async (r) => {
    await r.exec("changeset publish");
  },
});
