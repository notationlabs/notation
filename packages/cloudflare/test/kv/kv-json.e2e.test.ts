import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { getKVValue } from "src/api/kv";
import {
  accountId,
  describeE2e,
  kvNamespacesWithPrefix,
  poll,
  runPrefix,
  useProject,
} from "../e2e";

const expected = {
  features: { invoices: true, uploads: true },
  limits: { uploadMb: 50 },
};

describeE2e("kvJson()", () => {
  const project = useProject();
  const title = `${runPrefix}-config`;

  // The shared schema imports valibot. The link goes to the copy that
  // @notation/cloudflare uses.
  beforeAll(() => {
    const target = fileURLToPath(
      new URL("../../node_modules/valibot", import.meta.url),
    );
    const link = path.join(project.root, "node_modules/valibot");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");

    project.write(
      "shared/flags.ts",
      `
      import * as v from "valibot";

      export const FLAGS_KEY = "flags";

      export const Flags = v.object({
        features: v.record(v.string(), v.boolean()),
        limits: v.optional(v.record(v.string(), v.number())),
      });
      `,
    );
    project.write(
      "infra/config.ts",
      `
      import { kvJson } from "@notation/cloudflare/kv";
      import { kv } from "@notation/cloudflare/resources";
      import { Flags, FLAGS_KEY } from "../shared/flags";

      export const config = new kv.KVNamespace("config", {
        config: { Title: "${title}" },
      });

      export const flags = kvJson({
        id: "flags",
        namespace: config,
        key: FLAGS_KEY,
        schema: Flags,
        value: { features: {} },
      });
      `,
    );
    project.write(
      "infra/billing.ts",
      `
      import { flags } from "./config";

      flags.contribute({ features: { invoices: true } });
      `,
    );
    project.write(
      "infra/uploads.ts",
      `
      import { flags } from "./config";

      flags.contribute({ features: { uploads: true }, limits: { uploadMb: 50 } });
      `,
    );
    project.write(
      "infra/main.ts",
      `
      import "./billing";
      import "./uploads";
      `,
    );
    project.write(
      "runtime/api.ts",
      `
      import {
        $worker,
        readKVJson,
        type WorkerHandler,
      } from "@notation/cloudflare/workers";
      import { Flags, FLAGS_KEY } from "../shared/flags";
      import { config } from "../infra/config";

      export const worker = $worker({
        id: "api",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ CONFIG: config }),
      });

      export default {
        async fetch(request, env) {
          const flags = await readKVJson(env.CONFIG, FLAGS_KEY, Flags);
          if (!flags) return new Response("missing", { status: 404 });
          return Response.json(flags);
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
  });

  it("writes the document with both contributions, and a Worker reads it back", async () => {
    await project.notation("deploy");

    const namespaces = await kvNamespacesWithPrefix(runPrefix);
    expect(namespaces.map((namespace) => namespace.title)).toEqual([title]);
    expect(await getKVValue(accountId, namespaces[0]!.id, "flags")).toBe(
      JSON.stringify(expected),
    );

    const [workerName] = await project.workerNames();
    const fetched = await poll(project.url(workerName!), {
      done: (response) => response.ok,
    });
    expect(fetched.ok).toBe(true);
    expect(JSON.parse(fetched.body ?? "")).toEqual(expected);
  });
});
