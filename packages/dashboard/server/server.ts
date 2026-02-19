import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import chokidar from "chokidar";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({});

const defaultStatePath = path.join(process.cwd(), ".notation", "state.json");
const statePath = process.env.NOTATION_STATE_PATH ?? defaultStatePath;

fastify.register(fastifyStatic, {
  root: path.join(__dirname, "./"),
  prefix: "/",
});

fastify.get("/state", (request, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");

  const sendState = async () => {
    try {
      const state = await fs.readFile(statePath, "utf8");
      reply.raw.write(`data: ${JSON.stringify(JSON.parse(state))}\n\n`);
    } catch (error) {
      console.error("Error reading state.json:", error);
    }
  };

  const watcher = chokidar.watch(statePath);

  watcher.on("change", sendState);

  sendState();

  request.raw.on("close", () => {
    watcher.close();
  });

  reply.hijack();
});

export const startDashboardServer = async (port: number = 6682) => {
  try {
    await fastify.listen({ port });
    console.log("\nNotation dashboard is running on:\n\n");
    console.log(`➜ http://localhost:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};
