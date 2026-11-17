import { expect, it } from "vitest";
import { describeE2e, poll, useProject } from "../e2e";

describeE2e("url", () => {
  const project = useProject();

  // A library in node_modules generates a router Worker with worker() and
  // bundle(), binds the router's own URL with addBindings(), and returns the
  // URL. The infra entry binds a URL joined from it to a $worker, and the
  // $worker's URL back to the router. RFC 0026's router example also hosts
  // a namespace with a container, through durableObject() from RFC 0025,
  // which this package doesn't have yet.
  function writeProject() {
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
      import { addBindings, worker } from "@notation/cloudflare/workers";

      export function router({ id }) {
        const code = bundle({
          id,
          platform: "workerd",
          entry: fileURLToPath(new URL("./template.js", import.meta.url)),
        });
        const app = worker({ id, code, compatibilityDate: "2026-10-12" });
        addBindings(app, { OWN_URL: app.url });
        return { worker: app, url: app.url };
      }
      `,
    );
    project.write(
      "node_modules/acme-router/template.js",
      `
      export default {
        fetch: (request, env) =>
          Response.json({ own: env.OWN_URL, web: env.WEB_URL }),
      };
      `,
    );
    project.write(
      "runtime/web.ts",
      `
      import { $worker } from "@notation/cloudflare/workers";

      export const web = $worker({ id: "web", compatibilityDate: "2026-10-12" });

      export default {
        fetch: (request, env) => Response.json({ callback: env.ROUTER_CALLBACK }),
      };
      `,
    );
    project.write(
      "infra/main.ts",
      `
      import { text } from "@notation/resource";
      import { addBindings } from "@notation/cloudflare/workers";
      import { router } from "acme-router";
      import { web } from "../runtime/web";

      const api = router({ id: "api" });
      addBindings(api.worker, { WEB_URL: web.url });
      addBindings(web, { ROUTER_CALLBACK: text\`\${api.url}/callback\` });
      `,
    );
  }

  it("deploys a router that binds its own URL, and Workers that bind each other's URLs", async () => {
    writeProject();
    await project.notation("deploy");
    const all = await project.workerNames();
    const nameOf = (id: string) =>
      all.find((name) => name.startsWith(`${project.scope}${id}-`))!;
    const api = project.url(nameOf("api"));
    const web = project.url(nameOf("web"));

    const routed = await poll(`${api}/`);
    expect(routed.ok).toBe(true);
    expect(JSON.parse(routed.body ?? "")).toEqual({ own: api, web });
    const called = await poll(`${web}/`);
    expect(called.ok).toBe(true);
    expect(JSON.parse(called.body ?? "")).toEqual({
      callback: `${api}/callback`,
    });
  });
});
