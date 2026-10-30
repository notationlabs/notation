import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "api-gateway-authorizer",
  entries: {
    api: "infra/api.ts",
  },
  defaultStage: "dev",
});
