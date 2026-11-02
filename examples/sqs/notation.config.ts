import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "sqs",
  entry: "infra/orders.ts",
  defaultStage: "dev",
});
