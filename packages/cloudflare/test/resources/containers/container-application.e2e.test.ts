import { afterAll, expect, it } from "vitest";
import {
  api,
  describeE2e,
  namespacesWithPrefix,
  poll,
  runPrefix,
  useProject,
} from "../../e2e";

// traefik/whoami serves its hostname and the request's headers on port 80.
// The digests are of the linux/amd64 images of v1.11.0 and v1.10.4.
const IMAGE_V1 =
  "docker.io/traefik/whoami@sha256:4f90b33ddca9c4d4f06527070d6e503b16d71016edea036842be2a84e60c91cb";
const IMAGE_V2 =
  "docker.io/traefik/whoami@sha256:02d8fe035f170f91cbb5e458a57f4cefab747436f8244a0eb2d66785fe5e565f";

// The Worker sends each request to one Sandbox object, which starts its
// container and forwards the request to the container's port 80. For a few
// minutes after the application is created, Cloudflare has no instance to
// give the object, and the start fails. The object answers each request at
// once with the error, and the test polls until the container answers.
const workerModule = `
  import { DurableObject } from "cloudflare:workers";

  export class Sandbox extends DurableObject {
    async fetch(request) {
      const container = this.ctx.container;
      if (!container.running) container.start();
      try {
        return await container.getTcpPort(80).fetch("http://container/");
      } catch (error) {
        return new Response("container not reachable: " + error, { status: 503 });
      }
    }
  }

  export default {
    fetch(request, env) {
      return env.SANDBOX.getByName("one").fetch(request);
    },
  };
`;

// Cloudflare refuses an application name with two consecutive dashes, so the
// name doesn't follow the <app>--<stage>-- form of the Worker's name.
// Only resources that a group adds are deployed, so the module declares
// the resources in a group.
const infraModule = (settings: { maxInstances: number; image: string }) => `
  import { containers, workers } from "@notation/cloudflare/resources";
  import { ResourceGroup } from "@notation/resource";
  import { fs } from "@notation/std/resources";

  class Sandbox extends ResourceGroup {
    platform = "cloudflare";

    constructor() {
      super("Sandbox", "sandbox");
      const code = this.add(
        new fs.File("worker:api:code", { config: { filePath: "worker/index.js" } }),
      );
      const script = this.add(
        new workers.WorkerScript("worker:api", {
          config: {
            CompatibilityDate: "2026-10-12",
            Bindings: [
              { type: "durable_object_namespace", name: "SANDBOX", class_name: "Sandbox" },
            ],
            DurableObjectNamespaces: [
              { id: "sandboxes", className: "Sandbox", container: true },
            ],
          },
          dependencies: { code },
        }),
      );
      this.add(
        new workers.WorkerSubdomain("worker:api:subdomain", {
          dependencies: { script },
        }),
      );
      this.add(
        new containers.ContainerApplication("sandbox", {
          config: {
            Name: "${runPrefix}-sandbox",
            HostedNamespaceId: "sandboxes",
            MaxInstances: ${settings.maxInstances},
            Configuration: { image: "${settings.image}", instance_type: "lite" },
          },
          dependencies: { script },
        }),
      );
    }
  }

  new Sandbox();
`;

type Application = {
  id: string;
  name: string;
  max_instances: number;
  configuration: { image: string; vcpu?: number; memory_mib?: number };
  durable_objects?: { namespace_id: string };
};

async function applicationsWithPrefix(prefix: string): Promise<Application[]> {
  const response = await api<Application[] | null>(
    "GET",
    "/containers/applications",
  );
  if (!response.success) {
    throw new Error(
      `Listing container applications failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return (response.result ?? []).filter((application) =>
    application.name.startsWith(prefix),
  );
}

async function namespaceIdOf(script: string, className: string) {
  const response = await api<{ id: string; script: string; class: string }[]>(
    "GET",
    "/workers/durable_objects/namespaces?per_page=1000",
  );
  return response.result.find(
    (namespace) => namespace.script === script && namespace.class === className,
  )?.id;
}

describeE2e("ContainerApplication", () => {
  const project = useProject();

  // Registered after useProject, so it runs before useProject's cleanup.
  // An application that a failed deploy or destroy left behind is deleted
  // before its Worker.
  afterAll(async () => {
    for (const application of await applicationsWithPrefix(runPrefix)) {
      await api("DELETE", `/containers/applications/${application.id}`);
    }
    expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
  });

  let scriptName: string;
  let applicationId: string;

  it("creates the application for the Worker's container namespace", async () => {
    project.write("worker/index.js", workerModule);
    project.write(
      "infra/main.ts",
      infraModule({ maxInstances: 1, image: IMAGE_V1 }),
    );
    await project.notation("deploy");

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    scriptName = names[0]!;
    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: scriptName, class: "Sandbox" },
    ]);

    const applications = await applicationsWithPrefix(runPrefix);
    expect(applications).toHaveLength(1);
    const application = applications[0]!;
    applicationId = application.id;
    expect(application).toMatchObject({
      name: `${runPrefix}-sandbox`,
      max_instances: 1,
      // Cloudflare stores the resources of the instance type, not its name.
      configuration: { image: IMAGE_V1, vcpu: 0.0625, memory_mib: 256 },
      durable_objects: {
        namespace_id: await namespaceIdOf(scriptName, "Sandbox"),
      },
    });
  });

  it("serves a request through the Worker from the container", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    const fetched = await poll(`${project.url(scriptName)}/`, {
      timeoutMs: 480_000,
    });
    expect(fetched).toMatchObject({
      ok: true,
      body: expect.stringContaining("Hostname:"),
    });
  }, 600_000);

  it("updates the instance limit and rolls out a new image on a second deploy", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    project.write(
      "infra/main.ts",
      infraModule({ maxInstances: 2, image: IMAGE_V2 }),
    );
    await project.notation("deploy");

    const applications = await applicationsWithPrefix(runPrefix);
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      id: applicationId,
      max_instances: 2,
    });
    const rollouts = await api<{ target_configuration?: { image: string } }[]>(
      "GET",
      `/containers/applications/${applicationId}/rollouts`,
    );
    expect(rollouts.success).toBe(true);
    expect(
      rollouts.result.map((rollout) => rollout.target_configuration?.image),
    ).toContain(IMAGE_V2);
  }, 600_000);

  it("deletes the application and the Worker on destroy", async () => {
    await project.notation("destroy");

    expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
    expect(await project.workerNames()).toEqual([]);
  }, 600_000);
});
