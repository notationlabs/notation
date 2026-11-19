import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

export const logSink = $worker({
  id: "log-sink",
  compatibilityDate: "2026-10-12",
  url: false,
});

export default {
  async tail(events) {
    for (const event of events) {
      console.log(event.scriptName, event.outcome, event.logs.length);
    }
  },
} satisfies WorkerHandler<typeof logSink>;
