import crypto from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  api,
  describeE2e,
  poll,
  useProject,
  versionIds,
  type Fetched,
} from "../e2e";

const SECRET_KEY = "NOTATION_E2E_ORDER_SECRET";
// Deploy never sets it, so the value of its source can't be loaded.
const UNSET_KEY = "NOTATION_E2E_UNSET_SECRET";

describeE2e("$worker with a Worker secret, during deploy", () => {
  const project = useProject();
  const secret = `token-${crypto.randomBytes(8).toString("hex")}`;

  // The Worker answers `<version>:<TOKEN>`, or `<version>:missing` when it
  // has no TOKEN.
  const writeWorker = (
    id: string,
    { version, bind }: { version: string; bind?: string },
  ) =>
    project.write(
      `runtime/${id}.ts`,
      `
      import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
      import * as secrets from "../infra/main";

      export const worker = $worker({
        id: "${id}",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ ${bind ? `TOKEN: secrets.${bind}` : ""} }),
      });

      export default {
        async fetch(request, env) {
          const token = (env as { TOKEN?: string }).TOKEN ?? "missing";
          return new Response("${version}:" + token);
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );

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
      import { sources } from "@notation/std/resources";

      export const token = new sources.Env("token", {
        config: { key: "${SECRET_KEY}" },
      }).credentials.value;
      export const unset = new sources.Env("unset", {
        config: { key: "${UNSET_KEY}" },
      }).credentials.value;
      `,
    );
    process.env[SECRET_KEY] = secret;
    delete process.env[UNSET_KEY];
  });

  afterAll(() => {
    delete process.env[SECRET_KEY];
  });

  const workerName = async (id: string) =>
    (await project.workerNames()).find((name) =>
      name.startsWith(`${project.scope}${id}-`),
    );

  // Requests the Worker's workers.dev URL every half second, from when the
  // Worker exists until `stop`, and records each response.
  function watch(id: string) {
    const seen: Fetched[] = [];
    let stopped = false;
    const running = (async () => {
      let name: string | undefined;
      while (!stopped) {
        name ??= await workerName(id);
        if (name) {
          seen.push(await poll(project.url(name), { done: () => true }));
        }
        await sleep(500);
      }
    })();
    return {
      seen,
      stop: async () => {
        stopped = true;
        await running;
      },
    };
  }

  // The bindings of each version of the Worker that runs the code of its
  // latest version. A secret write deploys a version with the code of the
  // one before it, so a version that runs the latest code without TOKEN
  // means that code went live before its secret was set.
  async function bindingsOfLatestCode(name: string) {
    const versions = await Promise.all(
      (await versionIds(name)).map(async (id) => {
        const response = await api<{
          resources: { script: { etag: string }; bindings: { name: string }[] };
        }>("GET", `/workers/scripts/${name}/versions/${id}`);
        return response.result.resources;
      }),
    );
    const latest = versions[0]!.script.etag;
    return versions
      .filter((version) => version.script.etag === latest)
      .map((version) => version.bindings.map((binding) => binding.name));
  }

  // Deploys while watching the Worker, then waits until it serves `expected`.
  // workers.dev can serve an earlier version for a while after an upload,
  // and serves a new Worker only once deploy has turned on its workers.dev
  // URL, after the upload of its code. So the responses can miss a
  // version, and bindingsOfLatestCode is the check that covers each one.
  // Every earlier version is code that has its secret or doesn't read it, so
  // a late response can't show the new code without the secret.
  async function deployWatching(id: string, expected: string) {
    const watcher = watch(id);
    try {
      await project.notation("deploy");
      const name = (await workerName(id))!;
      const last = await poll(project.url(name), {
        done: (fetched) => fetched.body === expected,
      });
      expect(last.body).toBe(expected);
    } finally {
      await watcher.stop();
    }
    return { name: (await workerName(id))!, seen: watcher.seen };
  }

  it("never serves a new Worker's code without its secret", async () => {
    writeWorker("fresh", { version: "v1", bind: "token" });

    const { name, seen } = await deployWatching("fresh", `v1:${secret}`);

    expect(seen.filter((fetched) => fetched.body === "v1:missing")).toEqual([]);
    expect(await bindingsOfLatestCode(name)).toEqual([["TOKEN"]]);

    writeWorker("fresh", { version: "v2" });
    const after = await deployWatching("fresh", "v2:missing");
    expect(after.name).toBe(name);
  });

  it("sets a secret that a live Worker gains before its new code serves requests", async () => {
    writeWorker("live", { version: "v1" });
    const before = await deployWatching("live", "v1:missing");

    writeWorker("live", { version: "v2", bind: "token" });
    const { name, seen } = await deployWatching("live", `v2:${secret}`);

    expect(seen.filter((fetched) => fetched.body === "v2:missing")).toEqual([]);
    expect(await bindingsOfLatestCode(name)).toEqual([["TOKEN"]]);
    expect(name).toBe(before.name);
  });

  it("creates no Worker when the value of its secret can't be loaded", async () => {
    writeWorker("new-unset", { version: "v1", bind: "unset" });

    await expect(project.notation("deploy")).rejects.toThrow();

    expect(await workerName("new-unset")).toBeUndefined();
    // Deploy covers every Worker of the project, so the next tests need this
    // one to deploy.
    writeWorker("new-unset", { version: "v1" });
  });

  it("uploads nothing when a live Worker gains a secret whose value can't be loaded", async () => {
    writeWorker("unset", { version: "v1" });
    const before = await deployWatching("unset", "v1:missing");

    writeWorker("unset", { version: "v2", bind: "unset" });
    await expect(project.notation("deploy")).rejects.toThrow();
    expect(
      (await poll(project.url(before.name), { done: () => true })).body,
    ).toBe("v1:missing");
  });
});
