import { defineConfig } from "@notation/core";

export default defineConfig({
  app: "sqs",
  entries: {
    orders: "infra/orders.ts",
  },
  defaultStage: "dev",
});
