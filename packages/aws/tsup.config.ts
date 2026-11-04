import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/api-gateway/index.ts",
    "src/event-bridge/index.ts",
    "src/lambda/index.ts",
    "src/lambda.fn/index.ts",
    "src/sqs/index.ts",
    "src/shared/index.ts",
    "src/testing/index.ts",
    "src/testing/register/index.ts",
  ],
  splitting: false,
  dts: true,
  format: ["esm"],
  platform: "node",
});
