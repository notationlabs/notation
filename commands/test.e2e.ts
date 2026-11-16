import { defineCommand } from "@pokit/core";
import { runE2e } from "./_lib/e2e";

export const command = defineCommand({
  label: "Run the end-to-end tests, except the slow tests",
  run: (r) => runE2e(r, "test:e2e"),
});
