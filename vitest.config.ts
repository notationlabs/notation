/// <reference types="vitest" />

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Opt in to the workspace source dirs so stray trees (e.g. .claude/worktrees) are ignored.
    include: ["{packages,examples}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // End-to-end tests deploy to real provider accounts. `pok test e2e` runs them.
    exclude: [...configDefaults.exclude, "**/*.e2e.test.ts"],
  },
});
