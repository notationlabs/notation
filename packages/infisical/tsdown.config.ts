import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "sources/index": "src/sources/index.ts",
  },
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
