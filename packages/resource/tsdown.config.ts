import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/outputs.ts"],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
