import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { api, describeE2e, poll, runPrefix, useProject } from "../../e2e";

// The linux/amd64 image of traefik/whoami v1.11.0, which serves its hostname
// and the request's headers on port 80. The build adds one file to it, so
// that each version of the file gives a new digest.
const BASE_IMAGE =
  "docker.io/traefik/whoami@sha256:4f90b33ddca9c4d4f06527070d6e503b16d71016edea036842be2a84e60c91cb";

const REGISTRY = "registry.cloudflare.com";
const repository = `${runPrefix}-sandbox`;

// Checked only with credentials, so that a run without them doesn't wait
// for `docker info`.
function dockerIsRunning(): boolean {
  if (!process.env.CLOUDFLARE_API_TOKEN) return false;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

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

type Application = {
  id: string;
  name: string;
  configuration: { image: string };
  active_rollout_id?: string;
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

async function waitForRollout(applicationId: string): Promise<Application> {
  const deadline = Date.now() + 480_000;
  for (;;) {
    const response = await api<Application>(
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

async function namespace(): Promise<string> {
  const response = await api<{ external_account_id: string }>(
    "GET",
    "/containers/me",
  );
  if (!response.success) {
    throw new Error(
      `Reading the Containers account failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result.external_account_id;
}

// The value of a Basic Authorization header for the registry, as Wrangler
// sends it.
async function registryAuth(): Promise<string> {
  const response = await api<{ password: string }>(
    "POST",
    `/containers/registries/${REGISTRY}/credentials`,
    { expiration_minutes: 5, permissions: ["pull", "push"] },
  );
  if (!response.success) {
    throw new Error(
      `Making registry credentials failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return `Basic ${Buffer.from(`v1:${response.result.password}`).toString("base64")}`;
}

// The registry also lists the digest of each manifest, such as
// `sha256:...`, among the tags. They are left out.
async function repositoryTags(): Promise<string[]> {
  const response = await fetch(
    `https://${REGISTRY}/v2/${await namespace()}/${repository}/tags/list`,
    { headers: { Authorization: await registryAuth() } },
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Listing the tags failed with ${response.status}`);
  }
  const tags =
    ((await response.json()) as { tags?: string[] | null }).tags ?? [];
  return tags.filter((tag) => !tag.startsWith("sha256:"));
}

// Deletes each tag of the repository, as `wrangler containers images delete`
// does, since ContainerImage's delete leaves images in the registry.
async function deleteRepository(): Promise<void> {
  const base = `https://${REGISTRY}/v2/${await namespace()}/${repository}`;
  const auth = await registryAuth();
  for (const tag of await repositoryTags()) {
    const response = await fetch(`${base}/manifests/${tag}`, {
      method: "DELETE",
      headers: {
        Authorization: auth,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Deleting ${repository}:${tag} failed with ${response.status}`,
      );
    }
  }
  await fetch(`https://${REGISTRY}/v2/gc/layers`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
  }).catch(() => undefined);
}

describeE2e("ContainerImage", () => {
  describe.skipIf(!dockerIsRunning())("with a running Docker daemon", () => {
    const project = useProject();

    // Registered after useProject, so it runs before useProject's cleanup.
    afterAll(async () => {
      for (const application of await applicationsWithPrefix(runPrefix)) {
        await api("DELETE", `/containers/applications/${application.id}`);
      }
      await deleteRepository();
      expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
      expect(await repositoryTags()).toEqual([]);
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
          `^${REGISTRY}/${await namespace()}/${repository}@sha256:[a-f0-9]{64}$`,
        ),
      );
      expect(await repositoryTags()).toHaveLength(1);
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
      expect(await repositoryTags()).toHaveLength(2);
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
      expect(await repositoryTags()).toHaveLength(2);
    }, 600_000);
  });
});
