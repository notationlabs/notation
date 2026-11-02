import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "api-gateway-authorizer",
  entry: "infra/api.ts",
  defaultStage: "dev",
});
