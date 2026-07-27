import { defineConfig } from "vite";
import { docs } from "@notation/docs";

export default defineConfig({
  plugins: [
    docs({
      title: "Notation – Build serverless applications with TypeScript",
      github: "https://github.com/notationlabs/notation",
      favicon: { href: "/logo-badge.svg", type: "image/svg+xml" },
      categories: ["manual", "cli", "resources", "internals"],
      // The site now lives inside the docs directory it publishes, so the
      // Markdown and nav metadata sit alongside this config.
      contentDirectory: ".",
      pagesDirectory: "pages",
      defaultSlug: "manual/quickstart",
      logo: "./views/logo.tsx",
      // The docs site deliberately shows a lightbulb for its packages section.
      icons: { "file-text": "bulb" },
      version: { packageJson: "packages/core/package.json" },
      deployment: {
        name: "notation-docs",
        compatibilityDate: "2025-09-24",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
});
