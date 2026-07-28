import { defineCommand } from "@pokit/core";

// This was the `version` npm script. The build comes first so the versions
// changesets writes are stamped into freshly built output, and the install
// afterwards refreshes the lockfile with the bumped workspace versions.
export const command = defineCommand({
  label: "Apply changesets and bump versions",
  run: async (r) => {
    await r.exec("turbo run build");
    await r.exec("changeset version");
    await r.exec("pnpm install");
  },
});
