import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", config: "src/config/index.ts" },
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
