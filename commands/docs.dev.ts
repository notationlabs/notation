import { defineCommand } from "@pokit/core";
import { DOCS_SITE_DIR } from "./lib/docs-site";

export const command = defineCommand({
  label: "Start dev server",
  run: async (r) => {
    r.reporter.info("Starting documentation site at http://localhost:3005");
    await r.exec("pnpm exec docs dev --port 3005", { cwd: DOCS_SITE_DIR });
  },
});
