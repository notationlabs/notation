import { defineConfig } from "@notation/core";

export default defineConfig({
  app: "notation-starter",
  entries: {
    api: "infra/api.ts",
  },
  defaultStage: "dev",
});
