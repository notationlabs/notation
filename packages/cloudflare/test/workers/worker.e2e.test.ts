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

describeE2e("$worker RPC", () => {
  const project = useProject();

  // The router calls the github Worker over RPC through its own binding, and
  // through a binding that the infra entry adds with addBindings(). The
  // github Worker has no URL, as only the router calls it.
  function writeProject() {
    project.write(
      "runtime/github.ts",
      `
      import { WorkerEntrypoint } from "cloudflare:workers";
      import { $worker, type WorkerEnv } from "@notation/cloudflare/workers";

      export type Input = { body: string };

      export default class Github extends WorkerEntrypoint<WorkerEnv<typeof github>> {
        async receive(input: Input) {
          return { from: this.env.NAME, length: input.body.length };
        }
      }

      export const github = $worker({
        id: "github",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ NAME: "github" }),
        entrypoint: Github,
        url: false,
      });
      `,
    );
    project.write(
      "runtime/router.ts",
      `
      import type { Service } from "@cloudflare/workers-types";
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import { github, type Input } from "./github";
      import type Github from "./github";

      export const router = $worker({
        id: "router",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ GITHUB: github }),
      });

      export default {
        async fetch(request, env) {
          const input: Input = {
            body: new URL(request.url).searchParams.get("body") ?? "",
          };
          const channel = (env as Record<string, unknown>)
            .CHANNEL_GITHUB as Service<typeof Github>;
          return Response.json({
            typed: await env.GITHUB.receive(input),
            added: await channel.receive(input),
          });
        },
      } satisfies WorkerHandler<typeof router>;
      `,
    );
    project.write(
      "infra/main.ts",
      `
      import { addBindings } from "@notation/cloudflare/workers";
      import { github } from "../runtime/github";
      import { router } from "../runtime/router";

      addBindings(router, { CHANNEL_GITHUB: github });
      `,
    );
  }

  it("deploys two Workers, and calls a method of one from the other over RPC", async () => {
    writeProject();
    await project.notation("deploy");
    const all = await project.workerNames();
    expect(all).toHaveLength(2);
    const router = all.find((name) =>
      name.startsWith(`${project.scope}router-`),
    )!;

    const called = await poll(`${project.url(router)}/?body=hello`);
    expect(called.ok).toBe(true);
    expect(JSON.parse(called.body ?? "")).toEqual({
      typed: { from: "github", length: 5 },
      added: { from: "github", length: 5 },
    });
  });

  it("leaves the github Worker's code out of the router's bundle", () => {
    expect(project.read("dist/runtime/router/index.mjs")).not.toContain(
      "input.body.length",
    );
  });
});
