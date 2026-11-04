import type { DocsSite } from "@notation/docs";

// This repo's docs as the Manifest site, composed into notation.dev by
// notation-web. Paths resolve beside this file.
export default {
  slug: "manifest",
  label: "Manifest",
  root: new URL(".", import.meta.url),
  categories: ["manual", "cli", "resources", "internals"],
  defaultSlug: "manual/quickstart",
  version: { packageJson: "packages/core/package.json" },
  // The docs site deliberately shows a lightbulb for its packages section.
  icons: { "file-text": "bulb" },
} satisfies DocsSite;
