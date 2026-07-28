import { defineCommand } from "@pokit/core";
import { DOCS_SITE_DIR } from "./lib/docs-site";

export const command = defineCommand({
  label: "Build for production",
  run: async (r) => {
    await r.exec("pnpm exec docs build", { cwd: DOCS_SITE_DIR });
    r.reporter.success("Built notation-docs");
  },
});
