import { defineConfig } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import { docs, release } from "pok-plugins";
import type { ReleasePackage } from "pok-plugins";

// turbo builds the whole graph in dependency order, so every published package
// shares one build command and the plugin runs it once.
const build = "turbo run build";

const framework: ReleasePackage[] = [
  { file: "packages/aws/package.json", build },
  { file: "packages/aws.iac/package.json", build },
  { file: "packages/cli/package.json", build },
  { file: "packages/core/package.json", build },
  { file: "packages/dashboard/package.json", build },
  { file: "packages/esbuild-plugins/package.json", build },
  { file: "packages/reconciler/package.json", build },
  { file: "packages/resource/package.json", build },
  { file: "packages/state/package.json", build },
  { file: "packages/std.iac/package.json", build },
  { file: "packages/utils/package.json", build },
];

export default defineConfig({
  commandsDir: "./commands",
  ...createTerminalUI(),
  appName: "notation",
  plugins: [
    docs({ name: "notation-docs" }),
    release({
      packages: {
        framework: { label: "@notation/* framework packages", packages: framework },
        // create-notation versions independently (0.2.x vs the framework's
        // 0.12.x), so it gets its own group, tag, and commit template.
        "create-notation": {
          label: "create-notation scaffolder",
          tag: "create-notation@%s",
          commit: "release: create-notation@%s",
          packages: [
            {
              file: "packages/create-notation/package.json",
              build: "turbo run build --filter=create-notation",
            },
          ],
        },
      },
    }),
  ],
});
