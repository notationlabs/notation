import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import {
  accountId,
  api,
  describeE2e,
  kvNamespacesWithPrefix,
  poll,
  runPrefix,
  useProject,
} from "../e2e";

// `$worker` can't bind a KV namespace, so the project declares the resources
// itself.
const infraModule = (title: string) => `
  import { kv, workers } from "@notation/cloudflare/resources";
  import { fs } from "@notation/std/resources";

  const cache = new kv.KVNamespace("cache", { config: { Title: "${title}" } });

  const code = new fs.File("worker:kv:code", {
    config: { filePath: "code/worker.js" },
  });

  const script = new workers.WorkerScript("worker:kv", {
    config: {
      CompatibilityDate: "2026-10-12",
      Bindings: [
        {
          type: "kv_namespace",
          name: "CACHE",
          namespace_id: cache.outputRef("NamespaceId"),
        },
      ],
    },
    dependencies: { code, cache },
  });

  new workers.WorkerSubdomain("worker:kv:subdomain", {
    dependencies: { script },
  });
`;

// "/put?key=k&value=v" writes through the binding, and "/get?key=k" reads.
const workerModule = `
  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      if (url.pathname === "/put") {
        await env.CACHE.put(key, url.searchParams.get("value"));
        return new Response("stored");
      }
      const value = await env.CACHE.get(key);
      return new Response(value ?? "missing", { status: value === null ? 404 : 200 });
    },
  };
`;

async function getNamespace(id: string) {
  return await api<{ id: string; title: string }>(
    "GET",
    `/storage/kv/namespaces/${id}`,
  );
}

describeE2e("KVNamespace", () => {
  const project = useProject();
  const title = `${runPrefix}-cache`;
  const renamed = `${runPrefix}-renamed`;
  let namespaceId: string;
  let workerName: string;

  // The project links only @notation/cloudflare, and the infra module also
  // imports @notation/std. The link goes to the copy that
  // @notation/cloudflare uses, so both share one copy of @notation/resource,
  // whose module state holds the resource collection.
  beforeAll(() => {
    const target = fileURLToPath(
      new URL("../../node_modules/@notation/std", import.meta.url),
    );
    const link = path.join(project.root, "node_modules/@notation/std");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  });

  it("creates the namespace, and a Worker that reads and writes it through the binding", async () => {
    project.write("code/worker.js", workerModule);
    project.write("infra/main.ts", infraModule(title));
    await project.notation("deploy");

    const namespaces = await kvNamespacesWithPrefix(runPrefix);
    expect(namespaces.map((namespace) => namespace.title)).toEqual([title]);
    namespaceId = namespaces[0]!.id;

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    workerName = names[0]!;

    expect(
      await poll(`${project.url(workerName)}/put?key=greeting&value=hello`),
    ).toMatchObject({ ok: true, body: "stored" });
    expect(
      await poll(`${project.url(workerName)}/get?key=greeting`),
    ).toMatchObject({ ok: true, body: "hello" });
  });

  it("stores the Worker's writes in the namespace that deploy created", async () => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/greeting`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
  });

  it("renames the namespace in place when its title changes, and keeps its keys", async () => {
    project.write("infra/main.ts", infraModule(renamed));
    await project.notation("deploy");

    const namespace = await getNamespace(namespaceId);
    expect(namespace.result).toMatchObject({ id: namespaceId, title: renamed });
    expect(await kvNamespacesWithPrefix(runPrefix)).toEqual([
      { id: namespaceId, title: renamed },
    ]);
    expect(await project.workerNames()).toEqual([workerName]);
    expect(
      await poll(`${project.url(workerName)}/get?key=greeting`),
    ).toMatchObject({ ok: true, body: "hello" });
  });

  it("deletes the namespace and the Worker on destroy", async () => {
    await project.notation("destroy");

    const namespace = await getNamespace(namespaceId);
    expect(namespace.success).toBe(false);
    expect(namespace.status).toBe(404);
    expect(await kvNamespacesWithPrefix(runPrefix)).toEqual([]);
    expect(await project.workerNames()).toEqual([]);
  });
});
