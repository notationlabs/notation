import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  // node:sqlite only resolves with the node: prefix; don't let tsup strip it.
  removeNodeProtocol: false,
});
