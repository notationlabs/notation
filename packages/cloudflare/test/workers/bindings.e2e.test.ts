import crypto from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeE2e, poll, runPrefix, useProject } from "../e2e";

const SECRET_KEY = "NOTATION_E2E_WORKER_SECRET";

describeE2e("$worker bindings", () => {
  const project = useProject();
  const bucketName = `${project.scope}uploads`;
  const secrets = [
    `first-${crypto.randomBytes(8).toString("hex")}`,
    `second-${crypto.randomBytes(8).toString("hex")}`,
  ];
  let workerName: string;

  // The infra module imports @notation/std. The link goes to the copy that
  // @notation/cloudflare uses, so both share one copy of @notation/resource.
  beforeAll(() => {
    const target = fileURLToPath(
      new URL("../../node_modules/@notation/std", import.meta.url),
    );
    const link = path.join(project.root, "node_modules/@notation/std");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
    project.write(
      "infra/main.ts",
      `
      import { kv, r2 } from "@notation/cloudflare/resources";
      import { workerSecret } from "@notation/cloudflare/workers";
      import { env } from "@notation/std/sources";

      export const uploads = new r2.R2Bucket("uploads", {
        config: { BucketName: "${bucketName}", Jurisdiction: "default", StorageClass: "Standard" },
      });
      export const cache = new kv.KVNamespace("cache", {
        config: { Title: "${runPrefix}-bindings-cache" },
      });
      export const apiKey = workerSecret({ id: "api-key", source: env, key: "${SECRET_KEY}" });
      `,
    );
    // "/check" writes and reads through the R2 and KV bindings, and returns
    // the JSON binding. "/secret" returns the secret.
    project.write(
      "runtime/api.ts",
      `
      import { $worker, json, type WorkerHandler } from "@notation/cloudflare/workers";
      import { apiKey, cache, uploads } from "../infra/main";

      export const worker = $worker({
        id: "api",
        compatibilityDate: "2026-10-12",
        bindings: () => ({
          UPLOADS: uploads,
          CACHE: cache,
          CONFIG: json({ retries: 3, regions: ["weur"] }),
          API_KEY: apiKey,
        }),
      });

      export default {
        async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/secret") return new Response(env.API_KEY);
          await env.UPLOADS.put("greeting", "from r2");
          await env.CACHE.put("greeting", "from kv");
          const object = await env.UPLOADS.get("greeting");
          await env.UPLOADS.delete("greeting");
          return Response.json({
            r2: await object?.text(),
            kv: await env.CACHE.get("greeting"),
            config: env.CONFIG,
          });
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );
  });

  afterAll(() => {
    delete process.env[SECRET_KEY];
  });

  // The state and journal are kept under .notation in the project.
  function notationFiles(): string {
    const dir = path.join(project.root, ".notation");
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        readFileSync(path.join(entry.parentPath, entry.name), "latin1"),
      )
      .join("\n");
  }

  it("deploys a Worker that binds an R2 bucket, a KV namespace, a JSON value and a secret", async () => {
    process.env[SECRET_KEY] = secrets[0];
    await project.notation("deploy");
    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    workerName = names[0]!;

    const checked = await poll(`${project.url(workerName)}/check`);
    expect(checked.ok).toBe(true);
    // Parsed, as Cloudflare doesn't keep the key order of a JSON binding.
    expect(JSON.parse(checked.body ?? "")).toEqual({
      r2: "from r2",
      kv: "from kv",
      config: { retries: 3, regions: ["weur"] },
    });
    expect(await poll(`${project.url(workerName)}/secret`)).toMatchObject({
      ok: true,
      body: secrets[0],
    });
  });

  it("uploads the new value of the secret on the next deploy", async () => {
    process.env[SECRET_KEY] = secrets[1];
    await project.notation("deploy");

    expect(
      await poll(`${project.url(workerName)}/secret`, {
        done: (fetched) => fetched.body === secrets[1],
      }),
    ).toMatchObject({ ok: true, body: secrets[1] });
  });

  it("keeps the secret out of state, the journal and the runtime bundle", () => {
    const stored = notationFiles();
    const bundle = project.read("dist/runtime/api/index.mjs");
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(bundle).not.toContain(secret);
    }
  });
});
