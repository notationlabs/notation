import { expect, it } from "vitest";
import { describeE2e, poll, useProject } from "../e2e";

describeE2e("$worker", () => {
  const project = useProject();

  // The api Worker hosts the counters. The reports Worker binds them on the
  // api Worker, calls the api Worker through a service binding, and imports
  // a CommonJS package that requires a Node built-in.
  function writeProject() {
    project.write(
      "runtime/counter.ts",
      `
      import { DurableObject } from "cloudflare:workers";
      import { $durableObject } from "@notation/cloudflare/workers";

      export class Counter extends DurableObject {
        async increment() {
          const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
          await this.ctx.storage.put("count", count);
          return count;
        }
      }

      export const counters = $durableObject({ id: "counters", class: Counter });
      `,
    );
    project.write(
      "runtime/api.ts",
      `
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import { counters } from "./counter";
      export { Counter } from "./counter";

      export const worker = $worker({
        id: "api",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ COUNTERS: counters, GREETING: "hello" }),
      });

      export default {
        async fetch(request, env) {
          const count = await env.COUNTERS.getByName("one").increment();
          return new Response(\`\${env.GREETING} from api, count=\${count}\`);
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
    project.write(
      "runtime/reports.ts",
      `
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import cjs from "cjsdep";
      import { counters } from "./counter";
      import { worker as api } from "./api";

      export const worker = $worker({
        id: "reports",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ COUNTERS: counters, API: api }),
      });

      export default {
        async fetch(request, env) {
          const fromApi = await (await env.API.fetch(request)).text();
          const count = await env.COUNTERS.getByName("one").increment();
          return new Response(\`\${fromApi}; reports count=\${count}; cjs \${cjs.bare} \${cjs.prefixed}\`);
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
    project.write(
      "node_modules/cjsdep/package.json",
      JSON.stringify({ name: "cjsdep", main: "index.js" }),
    );
    project.write(
      "node_modules/cjsdep/index.js",
      [
        `const EventEmitter = require("events");`,
        `const { EventEmitter: Prefixed } = require("node:events");`,
        `module.exports = { bare: typeof EventEmitter, prefixed: typeof Prefixed };`,
      ].join("\n"),
    );
  }

  let names: Record<"api" | "reports", string>;

  it("deploys Workers that bind plain text, a namespace on another Worker, and another Worker", async () => {
    writeProject();
    await project.notation("deploy");
    const all = await project.workerNames();
    const nameOf = (id: string) =>
      all.find((name) => name.startsWith(`${project.scope}${id}-`))!;
    names = { api: nameOf("api"), reports: nameOf("reports") };

    expect(await poll(`${project.url(names.reports)}/`)).toMatchObject({
      ok: true,
      body: "hello from api, count=1; reports count=2; cjs function function",
    });
  });

  it("uploads runtime bundles that hold none of the infra code", () => {
    for (const id of ["api", "reports"]) {
      const bundle = project.read(`dist/runtime/${id}/index.mjs`);
      expect(bundle).not.toMatch(/WorkerScript|WorkerGroup|@notation\/std/);
      expect(bundle).not.toMatch(/__require\(/);
    }
  });
});
