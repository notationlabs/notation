import {
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  RepositoryNotFoundException,
} from "@aws-sdk/client-ecr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAccountLock } from "../../account-lock";
import { api, describeE2e, poll, runPrefix, useProject } from "../../e2e";
import { copyDockerHubImageToEcr } from "./ecr-image";

// traefik/whoami serves its hostname and the request's headers on port 80.
// The digest is of the linux/amd64 image of v1.11.0.
const SOURCE_REPOSITORY = "traefik/whoami";
const IMAGE_DIGEST =
  "sha256:4f90b33ddca9c4d4f06527070d6e503b16d71016edea036842be2a84e60c91cb";

const region = process.env.AWS_REGION!;
// The AWS_* user creates the repository and pushes the image. Cloudflare
// pulls it with the ECR_PULL_* user, which can only pull.
const hasAwsCredentials = Boolean(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  region &&
  process.env.ECR_PULL_ACCESS_KEY_ID &&
  process.env.ECR_PULL_SECRET_ACCESS_KEY,
);

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

// The access key ID is read from the environment when the CLI loads the
// module, so that it isn't written to the project.
const infraModule = (settings: {
  domain: string;
  image: string;
  storeId: string;
  secretName: string;
}) => `
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
      const registry = this.add(
        new containers.ContainerRegistry("registry", {
          config: {
            Domain: ${JSON.stringify(settings.domain)},
            Kind: "ECR",
            Auth: {
              public_credential: process.env.ECR_PULL_ACCESS_KEY_ID!,
              private_credential: {
                store_id: ${JSON.stringify(settings.storeId)},
                secret_name: ${JSON.stringify(settings.secretName)},
              },
            },
          },
        }),
      );
      const application = this.add(
        new containers.ContainerApplication("sandbox", {
          config: {
            Name: "${runPrefix}-sandbox",
            HostedNamespaceId: "sandboxes",
            MaxInstances: 1,
            Configuration: { image: ${JSON.stringify(settings.image)}, instance_type: "lite" },
          },
          dependencies: { script },
        }),
      );
      application.dependOn(registry);
    }
  }

  new Sandbox();
`;

type Application = {
  id: string;
  name: string;
  configuration: { image: string };
};

type Registry = { domain: string; kind?: string };

type StoreSecret = { id: string; name: string; status: string };

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

async function findRegistry(domain: string): Promise<Registry | undefined> {
  const response = await api<Registry[] | null>(
    "GET",
    "/containers/registries",
  );
  if (!response.success) {
    throw new Error(
      `Listing container registries failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return (response.result ?? []).find((registry) => registry.domain === domain);
}

async function deleteRegistry(domain: string): Promise<void> {
  if (!(await findRegistry(domain))) return;
  const response = await api(
    "DELETE",
    `/containers/registries/${encodeURIComponent(domain)}`,
  );
  if (!response.success) {
    throw new Error(
      `Deleting the registry ${domain} failed: ${JSON.stringify(response.errors)}`,
    );
  }
}

// The account lock has made sure that the account has a store.
async function accountStoreId(): Promise<string> {
  const response = await api<{ id: string }[]>("GET", "/secrets_store/stores");
  const id = response.result?.[0]?.id;
  if (!response.success || !id) {
    throw new Error(
      `Listing stores failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return id;
}

async function findSecret(
  storeId: string,
  name: string,
): Promise<StoreSecret | undefined> {
  const response = await api<StoreSecret[]>(
    "GET",
    `/secrets_store/stores/${storeId}/secrets?search=${encodeURIComponent(name)}&per_page=100`,
  );
  if (!response.success) {
    throw new Error(
      `Listing secrets failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return (response.result ?? []).find(
    (secret) => secret.name === name && secret.status !== "deleted",
  );
}

async function repositoryExists(
  ecr: ECRClient,
  repositoryName: string,
): Promise<boolean> {
  try {
    await ecr.send(
      new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }),
    );
    return true;
  } catch (error) {
    if (error instanceof RepositoryNotFoundException) return false;
    throw error;
  }
}

const describeWithAws = hasAwsCredentials ? describeE2e : describe.skip;

describeWithAws("ContainerRegistry", () => {
  // Every run uses the same registry domain, so the run holds the lock until
  // the record is deleted. Registered first, so it is released last.
  useAccountLock("container-registry");

  const ecr = new ECRClient({ region });
  const repositoryName = runPrefix;
  const secretName = `${runPrefix}-ecr`;
  let domain = "";
  let storeId = "";
  let image = "";

  beforeAll(async () => {
    storeId = await accountStoreId();
    const { repository } = await ecr.send(
      new CreateRepositoryCommand({ repositoryName }),
    );
    domain = repository!.repositoryUri!.split("/")[0]!;
    image = `${repository!.repositoryUri}@${IMAGE_DIGEST}`;
    await copyDockerHubImageToEcr(ecr, {
      repository: SOURCE_REPOSITORY,
      digest: IMAGE_DIGEST,
      ecrRepository: repositoryName,
    });

    // The containers scope is the one that `wrangler containers registries
    // configure` gives the secret it creates.
    const created = await api(
      "POST",
      `/secrets_store/stores/${storeId}/secrets`,
      [
        {
          name: secretName,
          value: process.env.ECR_PULL_SECRET_ACCESS_KEY,
          scopes: ["containers"],
          comment:
            "The secret access key of the ECR pull user for an end-to-end test",
        },
      ],
    );
    if (!created.success) {
      throw new Error(
        `Creating the secret failed: ${JSON.stringify(created.errors)}`,
      );
    }

    // With the lock held, a record for the domain is left over from a run
    // that was killed.
    await deleteRegistry(domain);
  });

  // Runs after useProject's destroy and before the lock is released.
  afterAll(async () => {
    try {
      if (domain) await deleteRegistry(domain);
    } finally {
      try {
        await ecr.send(
          new DeleteRepositoryCommand({ repositoryName, force: true }),
        );
      } catch (error) {
        if (!(error instanceof RepositoryNotFoundException)) throw error;
      } finally {
        const secret = storeId && (await findSecret(storeId, secretName));
        if (secret) {
          await api(
            "DELETE",
            `/secrets_store/stores/${storeId}/secrets/${secret.id}`,
          );
        }
      }
    }
    if (domain) expect(await findRegistry(domain)).toBeUndefined();
    expect(await repositoryExists(ecr, repositoryName)).toBe(false);
    if (storeId) expect(await findSecret(storeId, secretName)).toBeUndefined();
  });

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

  it("creates the registry and an application whose image is in it", async () => {
    project.write("worker/index.js", workerModule);
    project.write(
      "infra/main.ts",
      infraModule({ domain, image, storeId, secretName }),
    );
    await project.notation("deploy");

    expect(await findRegistry(domain)).toMatchObject({ domain });
    const names = await project.workerNames();
    expect(names).toHaveLength(1);
    scriptName = names[0]!;
    const applications = await applicationsWithPrefix(runPrefix);
    expect(applications).toHaveLength(1);
    expect(applications[0]!.configuration).toMatchObject({ image });
  });

  it("serves a request through the Worker from the private image", async () => {
    expect(scriptName, "the deploy made no Worker").toBeDefined();
    const fetched = await poll(`${project.url(scriptName)}/`, {
      timeoutMs: 480_000,
    });
    expect(fetched).toMatchObject({
      ok: true,
      body: expect.stringContaining("Hostname:"),
    });
  }, 600_000);

  it("deletes the application, the registry and the Worker on destroy", async () => {
    await project.notation("destroy");

    expect(await applicationsWithPrefix(runPrefix)).toEqual([]);
    expect(await findRegistry(domain)).toBeUndefined();
    expect(await project.workerNames()).toEqual([]);
  }, 600_000);
});
