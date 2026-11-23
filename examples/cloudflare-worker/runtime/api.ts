import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { logSink } from "runtime/log-sink";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  observability: { enabled: true },
  tailConsumers: () => [logSink],
});

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    console.log("request", request.method, pathname);
    return Response.json({ path: pathname });
  },
} satisfies WorkerHandler<typeof api>;
