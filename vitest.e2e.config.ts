/// <reference types="vitest" />

import { configDefaults, defineConfig } from "vitest/config";

// The tests of container resources, one glob for each provider.
const containers = [
  "packages/cloudflare/test/resources/containers/*.e2e.test.ts",
];

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // The container tests build and push images, and wait for rollouts that
    // can take several minutes, so `pok test e2e` leaves them out.
    projects: [
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["{packages,examples}/**/*.e2e.test.ts"],
          exclude: [...configDefaults.exclude, ...containers],
        },
      },
      {
        extends: true,
        test: { name: "containers", include: containers },
      },
    ],
  },
});
