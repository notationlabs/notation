import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Describe a change for the next release",
  run: async (r) => {
    await r.exec("changeset");
  },
});
