import { expect, it } from "vitest";
import {
  api,
  type ContainerApplication,
  containerApplicationsWithPrefix,
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
const infraModule = (settings: {
  maxInstances: number;
  configuration: Record<string, unknown>;
}) => `
  import { containers, workers } from "@notation/cloudflare/resources";
  import { fs } from "@notation/std/resources";

  const code = new fs.File("worker:api:code", {
    config: { filePath: "worker/index.js" },
  });
  const script = new workers.WorkerScript("worker:api", {
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
  });
  new workers.WorkerSubdomain("worker:api:subdomain", {
    dependencies: { script },
  });
  new containers.ContainerApplication("sandbox", {
    config: {
      Name: "${runPrefix}-sandbox",
      HostedNamespaceId: "sandboxes",
      MaxInstances: ${settings.maxInstances},
      Configuration: ${JSON.stringify(settings.configuration)},
    },
    dependencies: { script },
  });
`;

// Cloudflare refuses a rollout while another is running, and only updates
// the application's configuration when the rollout ends.
async function waitForRollout(
  applicationId: string,
): Promise<ContainerApplication> {
  const deadline = Date.now() + 480_000;
  for (;;) {
    const response = await api<ContainerApplication>(
      "GET",
      `/containers/applications/${applicationId}`,
    );
    if (response.success && !response.result.active_rollout_id) {
      return response.result;
    }
    if (Date.now() > deadline) {
      throw new Error(`The rollout of ${applicationId} didn't end in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
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
  const project = useProject({ containers: true });

  let scriptName: string;
  let applicationId: string;

  it("creates the application for the Worker's container namespace", async () => {
    project.write("worker/index.js", workerModule);
    project.write(
      "infra/main.ts",
      infraModule({
        maxInstances: 1,
        configuration: { image: IMAGE_V1, instance_type: "lite" },
      }),
    );
    await project.notation("deploy");

    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    scriptName = names[0]!;
    expect(await namespacesWithPrefix(project.scope)).toEqual([
      { script: scriptName, class: "Sandbox" },
    ]);

    const applications = await containerApplicationsWithPrefix(runPrefix);
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

  it("updates the instance limit and rolls out a new image, instance type and variables on a second deploy", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    project.write(
      "infra/main.ts",
      infraModule({
        maxInstances: 2,
        configuration: {
          image: IMAGE_V2,
          instance_type: "basic",
          environment_variables: [{ name: "GREETING", value: "hello" }],
        },
      }),
    );
    await project.notation("deploy");

    const applications = await containerApplicationsWithPrefix(runPrefix);
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

    expect((await waitForRollout(applicationId)).configuration).toMatchObject({
      image: IMAGE_V2,
      vcpu: 0.25,
      memory_mib: 1024,
      disk: { size_mb: 4000 },
      environment_variables: [{ name: "GREETING", value: "hello" }],
    });
  }, 600_000);

  it("removes the instance type and the variables that a third deploy leaves out", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    project.write(
      "infra/main.ts",
      infraModule({ maxInstances: 2, configuration: { image: IMAGE_V2 } }),
    );
    await project.notation("deploy");

    const application = await waitForRollout(applicationId);
    // The resources of a create that sets no size.
    expect(application.configuration).toMatchObject({
      image: IMAGE_V2,
      vcpu: 0.0625,
      memory_mib: 256,
      disk: { size_mb: 2000 },
    });
    expect(application.configuration.environment_variables ?? []).toEqual([]);
  }, 600_000);

  // Cloudflare refuses custom sizes below 1 vCPU and 3 GiB per vCPU.
  it("rolls out a disk size next to vcpu and memory_mib on a fourth deploy", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    project.write(
      "infra/main.ts",
      infraModule({
        maxInstances: 2,
        configuration: {
          image: IMAGE_V2,
          vcpu: 1,
          memory_mib: 3072,
          disk: { size_mb: 6000 },
        },
      }),
    );
    await project.notation("deploy");

    expect((await waitForRollout(applicationId)).configuration).toMatchObject({
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 6000 },
    });
  }, 600_000);

  it("resets the disk size that a fifth deploy leaves out", async () => {
    expect(applicationId, "the first deploy made no application").toBeDefined();
    project.write(
      "infra/main.ts",
      infraModule({
        maxInstances: 2,
        configuration: { image: IMAGE_V2, vcpu: 1, memory_mib: 3072 },
      }),
    );
    await project.notation("deploy");

    expect((await waitForRollout(applicationId)).configuration).toMatchObject({
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 2000 },
    });
  }, 600_000);

  it("deletes the application and the Worker on destroy", async () => {
    await project.notation("destroy");

    expect(await containerApplicationsWithPrefix(runPrefix)).toEqual([]);
    expect(await project.workerNames()).toEqual([]);
  }, 600_000);
});
