import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["server/server.ts"],
  tsconfig: "server/tsconfig.json",
  format: "esm",
  platform: "node",
  dts: { sourcemap: false },
  sourcemap: false,
  fixedExtension: false,
  // vite build has already written the client to dist.
  clean: false,
});
