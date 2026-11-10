import type { Platform } from "./types";

export const node: Platform = {
  build: {
    platform: "node",
    resolve: {
      conditionNames: ["notation-runtime", "node", "import", "default"],
    },
  },
  reexports: "entry",
};
