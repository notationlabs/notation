import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "api-gateway",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
