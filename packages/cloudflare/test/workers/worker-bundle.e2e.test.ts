import { expect, it } from "vitest";
import { describeE2e, poll, useProject } from "../e2e";

describeE2e("worker()", () => {
  const project = useProject();

  // A library in node_modules generates a router Worker from a route table.
  // The router hosts the rooms namespace, whose class the template exports.
  // It binds the counters namespace on the api Worker, and the api Worker
  // binds the router as a service.
  function writeProject(routes: Record<string, string>) {
    project.write(
      "node_modules/acme-router/package.json",
      JSON.stringify({
        name: "acme-router",
        type: "module",
        exports: "./index.js",
      }),
    );
    project.write(
      "node_modules/acme-router/index.js",
      `
      import { fileURLToPath } from "node:url";
      import { bundle } from "@notation/build/resources";
      import { worker } from "@notation/cloudflare/workers";

      export function router({ id, routes, bindings }) {
        const code = bundle({
          id,
          platform: "workerd",
          entry: fileURLToPath(new URL("./template.js", import.meta.url)),
          modules: {
            "virtual:routes": \`export default \${JSON.stringify(routes)};\`,
          },
        });
        return worker({ id, code, compatibilityDate: "2026-10-12", bindings });
      }
      `,
    );
    project.write(
      "node_modules/acme-router/template.js",
      `
      import { DurableObject } from "cloudflare:workers";
      import routes from "virtual:routes";

      export class Room extends DurableObject {
        async join() {
          const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
          await this.ctx.storage.put("count", count);
          return count;
        }
      }

      export default {
        async fetch(request, env) {
          const { pathname } = new URL(request.url);
          if (pathname === "/count") {
            return new Response(String(await env.COUNTERS.getByName("one").increment()));
          }
          if (pathname === "/room") {
            return new Response(String(await env.ROOMS.getByName("lobby").join()));
          }
          const body = routes[pathname];
          return body === undefined
            ? new Response("not found", { status: 404 })
            : new Response(body);
        },
      };
      `,
    );
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
      "runtime/room.ts",
      `
      import { $durableObject } from "@notation/cloudflare/workers";

      // The router's template exports the class under this name.
      class Room {}

      export const rooms = $durableObject({ id: "rooms", class: Room });
      `,
    );
    project.write(
      "infra/router.ts",
      `
      import { router as declareRouter } from "acme-router";
      import { counters } from "../runtime/counter";
      import { rooms } from "../runtime/room";

      export const router = declareRouter({
        id: "router",
        routes: ${JSON.stringify(routes)},
        bindings: () => ({ COUNTERS: counters, ROOMS: rooms }),
      });
      `,
    );
    project.write(
      "runtime/api.ts",
      `
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import { counters } from "./counter";
      import { router } from "../infra/router";
      export { Counter } from "./counter";

      export const worker = $worker({
        id: "api",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ COUNTERS: counters, ROUTER: router }),
      });

      export default {
        async fetch(request, env) {
          return env.ROUTER.fetch(request);
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
    project.write("infra/main.ts", `import "./router";`);
  }

  let names: Record<"api" | "router", string>;

  it("deploys a Worker whose code a library generates, which hosts a namespace and binds one on another Worker", async () => {
    writeProject({ "/": "home" });
    await project.notation("deploy");
    const all = await project.workerNames();
    const nameOf = (id: string) =>
      all.find((name) => name.startsWith(`${project.scope}${id}-`))!;
    names = { api: nameOf("api"), router: nameOf("router") };

    expect(await poll(`${project.url(names.router)}/`)).toMatchObject({
      ok: true,
      body: "home",
    });
    expect(await poll(`${project.url(names.router)}/count`)).toMatchObject({
      ok: true,
      body: "1",
    });
    expect(await poll(`${project.url(names.router)}/room`)).toMatchObject({
      ok: true,
      body: "1",
    });
    // The api Worker calls the router through its service binding.
    expect(await poll(`${project.url(names.api)}/`)).toMatchObject({
      ok: true,
      body: "home",
    });
  });

  it("records the files that the bundle read", () => {
    const inputs = JSON.parse(project.read("dist/.bundles/router/inputs.json"));
    expect(Object.keys(inputs.files)).toEqual(
      expect.arrayContaining([
        "node_modules/acme-router/package.json",
        "node_modules/acme-router/template.js",
      ]),
    );
  });

  it("uploads new code when the route table changes, and keeps the namespace", async () => {
    writeProject({ "/": "home", "/about": "about" });
    await project.notation("deploy");

    expect(
      await poll(`${project.url(names.router)}/about`, {
        done: (fetched) => fetched.body === "about",
      }),
    ).toMatchObject({ ok: true, body: "about" });
    expect(await poll(`${project.url(names.router)}/room`)).toMatchObject({
      ok: true,
      body: "2",
    });
  });
});
