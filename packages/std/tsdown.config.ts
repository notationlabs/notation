import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "resources/index": "src/resources/index.ts",
    track: "src/track.ts",
  },
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
