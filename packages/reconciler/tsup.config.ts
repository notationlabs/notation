import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/durable/index.ts"],
  dts: true,
  format: ["esm"],
});
