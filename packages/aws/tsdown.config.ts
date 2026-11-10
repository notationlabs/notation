import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/api-gateway/index.ts",
    "src/event-bridge/index.ts",
    "src/lambda/index.ts",
    "src/lambda/runtime.ts",
    "src/resources/index.ts",
    "src/sqs/index.ts",
  ],
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
});
