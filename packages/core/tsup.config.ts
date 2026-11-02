import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", config: "src/config/index.ts" },
  dts: true,
  format: ["esm"],
});
