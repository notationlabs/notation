import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "event-bridge",
  entry: "infra/index.ts",
  defaultStage: "dev",
});
