import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/shared/index.ts"],
  dts: true,
  format: ["esm"],
  platform: "node",
});
