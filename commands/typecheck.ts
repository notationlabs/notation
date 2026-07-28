import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Type-check every package",
  run: async (r) => {
    // --continue: report every package's errors, not just the first to fail.
    await r.exec("turbo run typecheck --continue");
  },
});
