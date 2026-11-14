import { afterAll, describe, expect, it } from "vitest";
import {
  api,
  describeE2e,
  namespacesWithPrefix,
  poll,
  runPrefix,
  useProject,
} from "../e2e";
import {
  applicationsWithPrefix,
  BASE_IMAGE,
  deleteApplicationsWithPrefix,
  deleteRepository,
  dockerIsRunning,
  REGISTRY,
  repositoryTags,
  type Application,
} from "../resources/containers/cloudflare-registry";

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
// them.
const workerModule = (id: string, { hosts }: { hosts: boolean }) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { counters } from "./counter";
  ${hosts ? `export { Counter } from "./counter";` : ""}

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ COUNTERS: counters }),
  });

  export default {
    async fetch(request, env) {
      const count = await env.COUNTERS.getByName("one").increment();
      return new Response(\`${id} count=\${count}\`);
    },
  } satisfies WorkerHandler<typeof worker>;
`;

describeE2e("$durableObject", () => {
  const project = useProject();

  // The host Worker hosts the counters, and the guest Worker binds them on
  // the host. `hostHostsCounters: false` swaps the roles.
  function writeProject({ hostHostsCounters }: { hostHostsCounters: boolean }) {
    project.write("runtime/counter.ts", counterModule);
    project.write(
      "runtime/host.ts",
      workerModule("host", { hosts: hostHostsCounters }),
    );
    project.write(
      "runtime/guest.ts",
      workerModule("guest", { hosts: !hostHostsCounters }),
    );
  }

  async function workerNames() {
    const names = await project.workerNames();
    const nameOf = (id: string) => {
      const name = names.find((name) =>
        name.startsWith(`${project.scope}${id}-`),
      );
      if (!name) throw new Error(`No Worker for ${id} among ${names}`);
      return name;
    };
    return { host: nameOf("host"), guest: nameOf("guest") };
  }

  let names: Awaited<ReturnType<typeof workerNames>>;
  let lastCount = 0;

  // Requests a Worker that increments the shared counter, and checks that
  // the count follows the last one, so the counter kept its objects.
  async function expectNextCount(name: string, id: string) {
    const fetched = await poll(`${project.url(name)}/`);
    expect(fetched).toMatchObject({
      ok: true,
      body: expect.stringMatching(new RegExp(`^${id} count=\\d+$`)),
    });
    const count = Number(fetched.body!.split("=")[1]);
    expect(count).toBe(lastCount + 1);
    lastCount = count;
  }

  it("hosts the namespace on the Worker that exports its class, under the Worker's generated name", async () => {
    writeProject({ hostHostsCounters: true });
    await project.notation("deploy");
    names = await workerNames();

    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: names.host, class: "Counter" },
    ]);
  });

  it("serves the same objects to the host and to a Worker that binds the namespace on it", async () => {
    await expectNextCount(names.host, "host");
    await expectNextCount(names.guest, "guest");
  });

  it("moves the namespace, with its objects, to the other Worker", async () => {
    writeProject({ hostHostsCounters: false });
    await project.notation("deploy");

    expect(await workerNames()).toEqual(names);
    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: names.guest, class: "Counter" },
    ]);
    await expectNextCount(names.guest, "guest");
    await expectNextCount(names.host, "host");
  });
});

const sandboxModule = ({ container }: { container: boolean }) => `
  import { DurableObject } from "cloudflare:workers";
  import { $durableObject } from "@notation/cloudflare/workers";

  export class Sandbox extends DurableObject {
    async fetch(request) {
      const container = this.ctx.container;
      if (!container) return new Response("no container");
      if (!container.running) container.start();
      try {
        return await container.getTcpPort(80).fetch("http://container/");
      } catch (error) {
        return new Response("container not reachable: " + error, { status: 503 });
      }
    }
  }

  export const sandboxes = $durableObject({
    id: "sandboxes",
    class: Sandbox,
    ${
      container
        ? `container: {
      image: { context: "image" },
      maxInstances: 1,
      instanceType: "lite",
    },`
        : ""
    }
  });
`;

// A Worker that binds the sandboxes, and exports their class when it hosts
// them.
const sandboxWorkerModule = (id: string, { hosts }: { hosts: boolean }) => `
  import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
  import { sandboxes } from "./sandbox";
  ${hosts ? `export { Sandbox } from "./sandbox";` : ""}

  export const worker = $worker({
    id: "${id}",
    compatibilityDate: "2026-10-12",
    bindings: () => ({ SANDBOXES: sandboxes }),
  });

  export default {
    fetch(request, env) {
      return env.SANDBOXES.getByName("one").fetch(request);
    },
  } satisfies WorkerHandler<typeof worker>;
`;

// Needs Docker, the Containers permission and the Workers Paid plan.
describeE2e("$durableObject with a container", () => {
  describe.skipIf(!dockerIsRunning())("with a running Docker daemon", () => {
    const project = useProject({ stage: "container" });
    const repository = `${runPrefix}--container--sandboxes`;

    // Registered after useProject, so it runs before useProject's cleanup,
    // which deletes the Workers. An application is deleted before its Worker.
    afterAll(async () => {
      await deleteApplicationsWithPrefix(runPrefix);
      await deleteRepository(repository);
      expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
      expect(await repositoryTags(repository)).toEqual([]);
    });

    // The api Worker hosts the sandboxes, and the jobs Worker binds them on
    // it. `apiHosts: false` swaps the roles.
    function writeProject({
      apiHosts,
      container = true,
    }: {
      apiHosts: boolean;
      container?: boolean;
    }) {
      project.write(
        "image/Dockerfile",
        `FROM ${BASE_IMAGE}\nCOPY version.txt /version.txt\n`,
      );
      project.write("image/version.txt", "1\n");
      project.write("runtime/sandbox.ts", sandboxModule({ container }));
      project.write(
        "runtime/api.ts",
        sandboxWorkerModule("api", { hosts: apiHosts }),
      );
      project.write(
        "runtime/jobs.ts",
        sandboxWorkerModule("jobs", { hosts: !apiHosts }),
      );
    }

    async function workerNames() {
      const names = await project.workerNames();
      const nameOf = (id: string) => {
        const name = names.find((name) =>
          name.startsWith(`${project.scope}${id}-`),
        );
        if (!name) throw new Error(`No Worker for ${id} among ${names}`);
        return name;
      };
      return { api: nameOf("api"), jobs: nameOf("jobs") };
    }

    async function expectContainerResponse(name: string) {
      const fetched = await poll(`${project.url(name)}/`, {
        timeoutMs: 480_000,
      });
      expect(fetched).toMatchObject({
        ok: true,
        body: expect.stringContaining("Hostname:"),
      });
    }

    let names: Awaited<ReturnType<typeof workerNames>>;
    let application: Application;

    it("builds the image, and creates a container application for the namespace on the hosting Worker", async () => {
      writeProject({ apiHosts: true });
      await project.notation("deploy");
      names = await workerNames();

      expect(await namespacesWithPrefix(project.scope)).toEqual([
        { script: names.api, class: "Sandbox" },
      ]);
      const applications = await applicationsWithPrefix(runPrefix);
      expect(applications).toHaveLength(1);
      application = applications[0]!;
      expect(application.name).toMatch(
        new RegExp(`^${runPrefix}-container-sandboxes-[0-9a-f]{8}$`),
      );
      expect(application.configuration.image).toMatch(
        new RegExp(`^${REGISTRY}/.+/${repository}@sha256:[a-f0-9]{64}$`),
      );
      expect(application.durable_objects?.namespace_id).toBe(
        await namespaceIdOf(names.api, "Sandbox"),
      );
    }, 600_000);

    it("serves a request from a container that runs the image", async () => {
      expect(application, "the first deploy made no application").toBeDefined();
      await expectContainerResponse(names.api);
      await expectContainerResponse(names.jobs);
    }, 600_000);

    it("moves the namespace to the other Worker, and keeps a container application for it", async () => {
      expect(application, "the first deploy made no application").toBeDefined();
      writeProject({ apiHosts: false });
      await project.notation("deploy");

      expect(await workerNames()).toEqual(names);
      expect(await namespacesWithPrefix(project.scope)).toEqual([
        { script: names.jobs, class: "Sandbox" },
      ]);
      const applications = await applicationsWithPrefix(runPrefix);
      expect(applications).toHaveLength(1);
      // The namespace keeps its ID. The application's ScriptName changed,
      // so deploy deleted the application and created it again.
      expect(await namespaceIdOf(names.jobs, "Sandbox")).toBe(
        application.durable_objects?.namespace_id,
      );
      expect(applications[0]).toMatchObject({
        name: application.name,
        configuration: { image: application.configuration.image },
        durable_objects: application.durable_objects,
      });
      expect(applications[0]!.id).not.toBe(application.id);
      await expectContainerResponse(names.jobs);
      await expectContainerResponse(names.api);
    }, 900_000);

    it("deletes the container application, and keeps the namespace, when container is removed", async () => {
      expect(application, "the first deploy made no application").toBeDefined();
      writeProject({ apiHosts: false, container: false });
      await project.notation("deploy");

      expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
      expect(await namespaceIdOf(names.jobs, "Sandbox")).toBe(
        application.durable_objects?.namespace_id,
      );
    }, 600_000);

    // Deploy uploads the Worker without the class in `containers` before it
    // deletes the application, which still uses the namespace.
    it("deletes the container application when container is removed, and keeps the namespace", async () => {
      expect(application, "the first deploy made no application").toBeDefined();
      writeProject({ apiHosts: false, container: false });
      await project.notation("deploy");

      expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
      expect(await namespaceIdOf(names.jobs, "Sandbox")).toBe(
        application.durable_objects?.namespace_id,
      );
      const fetched = await poll(`${project.url(names.jobs)}/`, {
        done: (fetched) => fetched.body === "no container",
      });
      expect(fetched).toMatchObject({
        ok: true,
        body: "no container",
      });
    }, 600_000);
  });
});

async function namespaceIdOf(
  script: string,
  className: string,
): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const response = await api<{ id: string; script: string; class: string }[]>(
      "GET",
      `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
    );
    if (!response.success || !response.result?.length) return undefined;
    const found = response.result.find(
      (namespace) =>
        namespace.script === script && namespace.class === className,
    );
    if (found) return found.id;
  }
}
