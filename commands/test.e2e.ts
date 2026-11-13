import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run the end-to-end tests against real provider accounts",
  run: async (r) => {
    // The tests run the built CLI, and their projects import the built packages.
    await r.exec("pnpm exec turbo run build");
    await r.exec("pnpm exec vitest run --config vitest.e2e.config.ts");
  },
});
