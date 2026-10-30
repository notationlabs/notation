import { defineConfig } from "@notation/core";

export default defineConfig({
  app: "event-bridge",
  entries: {
    schedule: "infra/schedule.ts",
  },
  defaultStage: "dev",
});
