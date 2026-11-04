import { notationTesting } from "@notation/aws/testing/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [notationTesting()],
  test: { include: ["runtime/checkout.test.ts"] },
});
