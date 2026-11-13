/// <reference types="vitest" />

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["{packages,examples}/**/*.live.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
