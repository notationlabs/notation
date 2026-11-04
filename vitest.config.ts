/// <reference types="vitest" />

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Opt in to the workspace source dirs so stray trees (e.g. .claude/worktrees) are ignored.
    include: ["{packages,examples}/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Fixture tests run in child processes, under their own config or hook.
    exclude: ["**/node_modules/**", "**/test/fixtures/**"],
  },
});
