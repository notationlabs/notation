import { afterAll, describe, expect, it } from "vitest";
import { api, describeE2e, poll, runPrefix, useProject } from "../../e2e";
import {
  applicationsWithPrefix,
  BASE_IMAGE,
  deleteApplicationsWithPrefix,
  deleteRepository,
  dockerIsRunning,
  REGISTRY,
  registryNamespace,
  repositoryTags,
  waitForRollout,
} from "./cloudflare-registry";

const repository = `${runPrefix}-sandbox`;

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

const infraModule = `
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
  const image = new containers.ContainerImage("sandbox:image", {
    config: { Repository: "${repository}", Context: "image" },
  });
  new containers.ContainerApplication("sandbox", {
    config: {
      Name: "${runPrefix}-sandbox",
      HostedNamespaceId: "sandboxes",
      MaxInstances: 1,
      Configuration: { image: image.outputRef("Image"), instance_type: "lite" },
    },
    dependencies: { script },
  });
`;

describeE2e("ContainerImage", () => {
  describe.skipIf(!dockerIsRunning())("with a running Docker daemon", () => {
    const project = useProject();

    // Registered after useProject, so it runs before useProject's cleanup.
    afterAll(async () => {
      await deleteApplicationsWithPrefix(runPrefix);
      await deleteRepository(repository);
      expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
      expect(await repositoryTags(repository)).toEqual([]);
    });

    let scriptName: string;
    let applicationId: string;
    let firstImage: string;

    function writeImage(version: string) {
      project.write(
        "image/Dockerfile",
        `FROM ${BASE_IMAGE}\nCOPY version.txt /version.txt\n`,
      );
      project.write("image/version.txt", `${version}\n`);
    }

    it("builds and pushes the image, and creates the application with its digest", async () => {
      project.write("worker/index.js", workerModule);
      writeImage("1");
      project.write("infra/main.ts", infraModule);
      await project.notation("deploy");

      const names = await project.workerNames();
      expect(names).toHaveLength(1);
      scriptName = names[0]!;
      const applications = await applicationsWithPrefix(runPrefix);
      expect(applications).toHaveLength(1);
      applicationId = applications[0]!.id;
      firstImage = applications[0]!.configuration.image;
      expect(firstImage).toMatch(
        new RegExp(
          `^${REGISTRY}/${await registryNamespace()}/${repository}@sha256:[a-f0-9]{64}$`,
        ),
      );
      expect(await repositoryTags(repository)).toHaveLength(1);
    }, 600_000);

    it("serves a request from a container that runs the image", async () => {
      expect(
        applicationId,
        "the first deploy made no application",
      ).toBeDefined();
      const fetched = await poll(`${project.url(scriptName)}/`, {
        timeoutMs: 480_000,
      });
      expect(fetched).toMatchObject({
        ok: true,
        body: expect.stringContaining("Hostname:"),
      });
    }, 600_000);

    it("pushes a new image and rolls out its digest when the build context changes", async () => {
      expect(
        applicationId,
        "the first deploy made no application",
      ).toBeDefined();
      writeImage("2");
      await project.notation("deploy");

      const rollouts = await api<
        { target_configuration?: { image: string } }[]
      >("GET", `/containers/applications/${applicationId}/rollouts`);
      expect(rollouts.success).toBe(true);
      const images = rollouts.result.map(
        (rollout) => rollout.target_configuration?.image,
      );
      const secondImage = images.find(
        (image) => image !== undefined && image !== firstImage,
      );
      expect(secondImage).toMatch(new RegExp(`^${REGISTRY}/.+@sha256:`));
      expect((await waitForRollout(applicationId)).configuration.image).toBe(
        secondImage,
      );
      // The delete of the replaced image leaves it in the registry.
      expect(await repositoryTags(repository)).toHaveLength(2);
    }, 600_000);

    it("deploys nothing when the build context is unchanged", async () => {
      expect(
        applicationId,
        "the first deploy made no application",
      ).toBeDefined();
      const before = await waitForRollout(applicationId);
      await project.notation("deploy");

      expect((await waitForRollout(applicationId)).configuration.image).toBe(
        before.configuration.image,
      );
      expect(await repositoryTags(repository)).toHaveLength(2);
    }, 600_000);
  });
});
