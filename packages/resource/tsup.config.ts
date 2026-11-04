import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/outputs.ts"],
  dts: true,
  format: ["esm"],
});
