import { defineConfig } from "@notation/core/config";

export default defineConfig({
  app: "cloudflare-worker",
  entry: "infra/main.ts",
  defaultStage: "dev",
});
