/// <reference types="vitest" />

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Opt in to the workspace source dirs so stray trees (e.g. .claude/worktrees) are ignored.
    include: ["{packages,examples}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Live tests deploy to a real Cloudflare account. `pok test live` runs them.
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
