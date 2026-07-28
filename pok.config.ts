import { defineConfig } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";
import { docs } from "pok-plugins";

export default defineConfig({
  commandsDir: "./commands",
  ...createTerminalUI(),
  appName: "notation",
  plugins: [docs({ name: "notation-docs" })],
});
