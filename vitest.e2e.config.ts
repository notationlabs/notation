/// <reference types="vitest" />

import { configDefaults, defineConfig } from "vitest/config";

// Tests that take minutes, such as those that build and push images and wait
// for rollouts. `pok test e2e` leaves them out.
const slow = ["packages/cloudflare/test/resources/containers/*.e2e.test.ts"];

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    testTimeout: 300_000,
    hookTimeout: 300_000,
    projects: [
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["{packages,examples}/**/*.e2e.test.ts"],
          exclude: [...configDefaults.exclude, ...slow],
        },
      },
      {
        extends: true,
        test: { name: "slow", include: slow },
      },
    ],
  },
});
