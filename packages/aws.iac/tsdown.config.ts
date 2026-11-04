import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/shared/index.ts"],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
