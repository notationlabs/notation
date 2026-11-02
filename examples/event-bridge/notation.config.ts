import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "event-bridge",
  entry: "infra/schedule.ts",
  defaultStage: "dev",
});
