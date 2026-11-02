import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "lambda-external",
  entry: "infra/index.ts",
  defaultStage: "dev",
});
