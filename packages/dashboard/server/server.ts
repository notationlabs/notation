import fastifyStatic from "@fastify/static";
import type { StateBackend, StateNode } from "@notation/state";
import Fastify from "fastify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDirectory = dirname(fileURLToPath(import.meta.url));

export type DashboardServerOptions = {
  state: StateBackend;
  pollInterval?: number;
};

export type StartDashboardServerOptions = DashboardServerOptions & {
  port?: number;
};

export async function readStateSnapshot(
  state: StateBackend,
): Promise<Record<string, StateNode>> {
  const nodes = await state.values();
  return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

export function createDashboardServer({
  state,
  pollInterval = 500,
}: DashboardServerOptions) {
  const server = Fastify({});

  server.register(fastifyStatic, {
    root: join(serverDirectory, "./"),
    prefix: "/",
  });

  server.get("/state", (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");

    let lastSnapshot: string | undefined;
    let reading = false;
    let closed = false;
    const sendState = async () => {
      if (reading || closed) return;
      reading = true;
      try {
        const snapshot = JSON.stringify(await readStateSnapshot(state));
        if (closed || snapshot === lastSnapshot) return;
        lastSnapshot = snapshot;
        reply.raw.write(`data: ${snapshot}\n\n`);
      } catch (error) {
        request.log.error(error, "Unable to read state");
      } finally {
        reading = false;
      }
    };

    const timer = setInterval(sendState, pollInterval);
    timer.unref();
    void sendState();

    request.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
    reply.hijack();
  });

  return server;
}

export async function startDashboardServer({
  port = 6682,
  ...options
}: StartDashboardServerOptions) {
  const server = createDashboardServer(options);
  await server.listen({ port });
  console.log("\nNotation dashboard is running on:\n\n");
  console.log(`➜ http://localhost:${port}`);
  return server;
}
