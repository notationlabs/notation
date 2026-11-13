import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime.ts",
    "src/resources/index.ts",
    "src/workers/index.ts",
    "src/workers/runtime.ts",
  ],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
