import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/resources/index.ts"],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
