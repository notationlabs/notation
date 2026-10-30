import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "lambda-external",
  entries: {
    lambdas: "infra/index.ts",
  },
  defaultStage: "dev",
});
