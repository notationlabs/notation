import { defineCommand } from "@pokit/core";
import { DOCS_SITE_DIR } from "./lib/docs-site";

// Deployment config is inline in the site's vite.config.ts, so wrangler picks
// up the emitted .wrangler/deploy/config.json — there is no wrangler.toml.
export const command = defineCommand({
  label: "Build and deploy to Cloudflare",
  run: async (r) => {
    await r.exec("pnpm exec docs deploy", { cwd: DOCS_SITE_DIR });
    r.reporter.success("Deployed notation-docs");
  },
});
