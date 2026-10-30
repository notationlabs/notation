import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "sqs",
  entries: {
    orders: "infra/orders.ts",
  },
  defaultStage: "dev",
});
