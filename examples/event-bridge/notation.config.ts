import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "event-bridge",
  entries: {
    schedule: "infra/schedule.ts",
  },
  defaultStage: "dev",
});
