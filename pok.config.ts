import { defineConfig } from "@pokit/core";
import { createTerminalUI } from "@pokit/terminal";

export default defineConfig({
  commandsDir: "./commands",
  ...createTerminalUI(),
  appName: "notation",
});
