import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { compileInfra, compileRuntimeModules } from "../src/compile";

// Inside this package, so that the project's imports of @notation/cloudflare
// resolve to the built package.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-cf-e2e-")));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

type Binding =
  | { type: "plain_text"; name: string; text: string }
  | {
      type: "durable_object_namespace";
      name: string;
      class_name: string;
      script_name?: string;
    }
  | { type: "service"; name: string; service: string };

type ScriptParams = {
  ScriptName: string;
  MainModule: string;
  CodeFilePath: string;
  CompatibilityDate: string;
  CompatibilityFlags: string[];
  Bindings: Binding[];
  DurableObjectNamespaces: { id: string; className: string }[];
};

// Evaluates the infra bundle in a separate process, as deploy does, and
// returns the params of each Worker's upload.
function workerParams(): Record<string, ScriptParams> {
  const script = `
    import { collectResourceGraph } from "@notation/resource";

    const graph = await collectResourceGraph(() => import("./dist/infra/main.mjs"), {
      scope: { app: "shop", stage: "dev" },
    });
    const params = {};
    for (const resource of graph.resources) {
      if (resource.type !== "cloudflare/workers/WorkerScript") continue;
      const code = resource.dependencies.code;
      code.setOutput({ ...code.config, sourceSha256: "hex", fileSha256: "sha" });
      params[resource.id] = await resource.getParams();
    }
    console.log(JSON.stringify(params));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "account" },
    },
  );
  return JSON.parse(output);
}

// Runs the Workers under workerd with the settings and bindings of their
// uploads, as Cloudflare would.
async function serve(workers: ScriptParams[], request: string) {
  const mf = new Miniflare({
    workers: workers.map((params) => ({
      config: {
        name: params.ScriptName,
        compatibilityDate: params.CompatibilityDate,
        compatibilityFlags: params.CompatibilityFlags,
        manifest: {
          mainModule: params.MainModule,
          modules: {
            [params.MainModule]: {
              type: "esm" as const,
              contents: readFileSync(
                path.join(root, params.CodeFilePath),
                "utf8",
              ),
            },
          },
        },
        env: Object.fromEntries(
          params.Bindings.map((binding) => [
            binding.name,
            binding.type === "plain_text"
              ? { type: "text" as const, value: binding.text }
              : binding.type === "service"
                ? { type: "worker" as const, worker: binding.service }
                : {
                    type: "durable-object" as const,
                    worker: binding.script_name ?? params.ScriptName,
                    exportName: binding.class_name,
                  },
          ]),
        ),
        exports: Object.fromEntries(
          params.DurableObjectNamespaces.map((namespace) => [
            namespace.className,
            { type: "durable-object" as const, storage: "sqlite" as const },
          ]),
        ),
      },
    })) as any,
  });
  try {
    const response = await mf.dispatchFetch(request);
    return await response.text();
  } finally {
    await mf.dispose();
  }
}

function writeProject() {
  write("infra/main.ts", `export {};`);
  write(
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
  write(
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
  write(
    "runtime/reports.ts",
    `
    import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
    import { counters } from "./counter";
    import { worker as api } from "./api";

    export const worker = $worker({
      id: "reports",
      compatibilityDate: "2026-10-12",
      url: false,
      bindings: () => ({ COUNTERS: counters, API: api }),
    });

    export default {
      async fetch(request, env) {
        const fromApi = await (await env.API.fetch(request)).text();
        const count = await env.COUNTERS.getByName("one").increment();
        return new Response(\`\${fromApi}; reports count=\${count}\`);
      },
    } satisfies WorkerHandler<typeof worker>;
    `,
  );
}

it("deploys a Worker that hosts a namespace, and a Worker that binds it and calls the first", async () => {
  writeProject();
  await compileRuntimeModules(
    (await compileInfra(path.join(root, "infra/main.ts"))).modules,
  );

  const params = workerParams();
  expect(params).toEqual({
    "worker:api": {
      AccountId: "account",
      ScriptName: "shop--dev--api",
      MainModule: "index.mjs",
      CodeFilePath: "dist/runtime/api/index.mjs",
      CodeSha256: "sha",
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["nodejs_compat"],
      Bindings: [
        {
          type: "durable_object_namespace",
          name: "COUNTERS",
          class_name: "Counter",
        },
        { type: "plain_text", name: "GREETING", text: "hello" },
      ],
      DurableObjectNamespaces: [{ id: "counters", className: "Counter" }],
    },
    "worker:reports": {
      AccountId: "account",
      ScriptName: "shop--dev--reports",
      MainModule: "index.mjs",
      CodeFilePath: "dist/runtime/reports/index.mjs",
      CodeSha256: "sha",
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["nodejs_compat"],
      Bindings: [
        {
          type: "durable_object_namespace",
          name: "COUNTERS",
          class_name: "Counter",
          script_name: "shop--dev--api",
        },
        { type: "service", name: "API", service: "shop--dev--api" },
      ],
      DurableObjectNamespaces: [],
    },
  });

  // The reports Worker is first, so the request goes to it.
  const workers = [params["worker:reports"]!, params["worker:api"]!];
  expect(await serve(workers, "http://localhost/")).toBe(
    "hello from api, count=1; reports count=2",
  );

  for (const name of ["api", "reports"]) {
    const bundle = readFileSync(
      path.join(root, `dist/runtime/${name}/index.mjs`),
      "utf8",
    );
    expect(bundle).not.toMatch(/WorkerScript|WorkerGroup|@notation\/std/);
  }
}, 60_000);
