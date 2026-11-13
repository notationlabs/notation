import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run the live tests against a real Cloudflare account",
  run: async (r) => {
    // The test projects import the built packages.
    await r.exec("pnpm exec turbo run build");
    await r.exec("pnpm exec vitest run --config vitest.live.config.ts");
  },
});
