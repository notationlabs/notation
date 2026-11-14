import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/resources/index.ts",
    "src/secrets-store/index.ts",
    "src/tokens/index.ts",
    "src/workers/index.ts",
    "src/workers/runtime.ts",
  ],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
