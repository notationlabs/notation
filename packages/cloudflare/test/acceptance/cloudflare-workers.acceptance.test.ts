import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountSubdomain,
  api,
  deleteScriptsWithPrefix,
  hasCredentials,
  latestVersionId,
  namespacesWithPrefix,
  poll,
  runPrefix,
  scriptsWithPrefix,
} from "./cloudflare";

// Inside this package, so that the project's imports of @notation packages
// resolve from this package's node_modules.
const tmpDir = fileURLToPath(new URL("../../tmp", import.meta.url));
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(
  new URL("../../node_modules/@notation/cli/dist/index.js", import.meta.url),
);

// The project gets its own package.json, as this package's
// `"sideEffects": false` would otherwise let the infra build drop the
// project's modules. The build treats a bare import as a package only when it
// is installed in a node_modules folder, so the project links
// @notation/cloudflare into its own.
function setUpProject(root: string) {
  writeFileSync(path.join(root, "package.json"), `{ "private": true }`);
  const link = path.join(root, "node_modules/@notation/cloudflare");
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(packageDir, link, "dir");
}

const app = runPrefix;
const stage = "acceptance";
const scope = `${app}--${stage}--`;

// Long enough that deploy cuts the generated name to the 54 character limit.
const hostId = "hostworkerwithanidlongerthanthenamelimit";
const guestId = "guest";
// Cloudflare serves no preview URL for a Worker that hosts a Durable Object
// namespace, so the preview URL is tested on a Worker without one.
const plainId = "plainworkerwithanidlongerthanthenamelimit";

let root: string;
let subdomain: string;

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

// Runs the built CLI in the test project, as a user would.
async function notation(command: "deploy" | "destroy") {
  try {
    await promisify(execFile)(
      process.execPath,
      [cli, command, "--config", path.join(root, "notation.config.ts")],
      { cwd: root, env: process.env, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`notation ${command} failed:\n${stdout}\n${stderr}`, {
      cause: error,
    });
  }
}

const counterModule = `
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
`;

// A Worker that binds the counters, and exports their class when it hosts
// them. "/self" calls the Worker through its binding to itself.
const workerModule = (
  id: string,
  { hosts, self }: { hosts: boolean; self: boolean },
) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { counters } from "./counter";
  ${hosts ? `export { Counter } from "./counter";` : ""}

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ COUNTERS: counters${self ? ", SELF: worker" : ""} }),
  });

  export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      ${self ? `if (url.pathname === "/self") return env.SELF.fetch(new URL("/", url));` : ""}
      const count = await env.COUNTERS.getByName("one").increment();
      return new Response(\`${id} count=\${count}\`);
    },
  } satisfies WorkerHandler<typeof worker>;
`;

// The host Worker hosts the counters and binds itself. The guest Worker
// binds the counters on the host.
function writeProject({ hostHostsCounters }: { hostHostsCounters: boolean }) {
  write(
    "notation.config.ts",
    `export default { app: "${app}", defaultStage: "${stage}", entry: "infra/main.ts" };`,
  );
  write("infra/main.ts", `export {};`);
  write("runtime/counter.ts", counterModule);
  write(
    "runtime/host.ts",
    workerModule(hostId, { hosts: hostHostsCounters, self: true }),
  );
  write(
    "runtime/guest.ts",
    workerModule(guestId, { hosts: !hostHostsCounters, self: false }),
  );
  write(
    "runtime/plain.ts",
    `
    import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

    export const worker = $worker({ id: "${plainId}", compatibilityDate: "2026-10-12" });

    export default {
      async fetch() {
        return new Response("${plainId}");
      },
    } satisfies WorkerHandler<typeof worker>;
    `,
  );
}

async function workerNames() {
  const names = await scriptsWithPrefix(scope);
  const nameOf = (id: string) => {
    const name = names.find((name) =>
      name.startsWith(`${scope}${id.slice(0, 4)}`),
    );
    if (!name) throw new Error(`No Worker for ${id} among ${names.join(", ")}`);
    return name;
  };
  return {
    host: nameOf(hostId),
    guest: nameOf(guestId),
    plain: nameOf(plainId),
    all: names,
  };
}

const urlOf = (name: string) => `https://${name}.${subdomain}.workers.dev`;

let lastCount = 0;

// Requests a Worker that increments the shared counter, and checks that the
// count follows the last one, so the counter kept its objects.
async function expectNextCount(url: string, id: string) {
  const fetched = await poll(url);
  expect(fetched).toMatchObject({
    ok: true,
    body: expect.stringMatching(new RegExp(`^${id} count=\\d+$`)),
  });
  const count = Number(fetched.body!.split("=")[1]);
  expect(count).toBe(lastCount + 1);
  lastCount = count;
}

describe.skipIf(!hasCredentials)(
  "Cloudflare Workers with generated names",
  () => {
    beforeAll(async () => {
      mkdirSync(tmpDir, { recursive: true });
      root = mkdtempSync(path.join(tmpDir, `${runPrefix}-`));
      setUpProject(root);
      subdomain = await accountSubdomain();
    });

    afterAll(async () => {
      try {
        if (root) await notation("destroy");
      } finally {
        // Catches what a failed deploy or destroy left behind.
        await deleteScriptsWithPrefix(scope);
        if (root) rmSync(root, { recursive: true, force: true });
      }
      expect(await scriptsWithPrefix(scope)).toEqual([]);
    });

    let names: Awaited<ReturnType<typeof workerNames>>;

    it("deploys a Worker whose generated name has 54 characters, and serves it on workers.dev", async () => {
      writeProject({ hostHostsCounters: true });
      await notation("deploy");
      names = await workerNames();

      expect(names.all).toHaveLength(3);
      expect(names.host).toMatch(
        new RegExp(`^${scope}hostworker[a-z]+-[0-9a-f]{8}$`),
      );
      expect(names.host).toHaveLength(54);
      expect(names.guest).toMatch(new RegExp(`^${scope}guest-[0-9a-f]{8}$`));
      expect(names.plain).toHaveLength(54);

      await expectNextCount(`${urlOf(names.host)}/`, hostId);
    });

    it("serves a 54 character Worker at the preview URL of its version", async () => {
      const version = await latestVersionId(names.plain);
      const label = `${version.slice(0, 8)}-${names.plain}`;
      expect(label).toHaveLength(63);
      expect(
        await poll(`https://${label}.${subdomain}.workers.dev/`),
      ).toMatchObject({
        ok: true,
        body: plainId,
      });
    });

    it("creates a Worker that binds itself in one upload", async () => {
      const versions = await api<{ items: unknown[] }>(
        "GET",
        `/workers/scripts/${names.host}/versions`,
      );
      expect(versions.result.items).toHaveLength(1);
      await expectNextCount(`${urlOf(names.host)}/self`, hostId);
    });

    it("lists the generated name as the Worker of its Durable Object namespace", async () => {
      expect(await namespacesWithPrefix(scope)).toEqual([
        { script: names.host, class: "Counter" },
      ]);
    });

    it("moves the namespace, with its objects, to the other Worker", async () => {
      writeProject({ hostHostsCounters: false });
      await notation("deploy");

      expect(await workerNames()).toEqual(names);
      expect(await namespacesWithPrefix(scope)).toEqual([
        { script: names.guest, class: "Counter" },
      ]);
      await expectNextCount(`${urlOf(names.guest)}/`, guestId);
      await expectNextCount(`${urlOf(names.host)}/`, hostId);
    });
  },
);
