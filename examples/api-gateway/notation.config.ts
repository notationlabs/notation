import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "api-gateway",
  entries: {
    api: "infra/api.ts",
  },
  defaultStage: "dev",
});
