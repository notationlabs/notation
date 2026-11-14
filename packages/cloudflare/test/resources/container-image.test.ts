import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import { ResourceNotFoundError, UNKNOWN_AFTER_APPLY } from "@notation/resource";
import { ContainerApplication } from "src/resources/containers/container-application";
import { ContainerImage } from "src/resources/containers/container-image";
import {
  DockerCommandError,
  DockerNotFoundError,
  runDocker,
} from "src/resources/containers/docker";
import { WorkerScript } from "src/resources/workers/worker-script";
import { calls, mockFetch, ok } from "../mock-api";

vi.mock("src/resources/containers/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/resources/containers/docker")>()),
  runDocker: vi.fn(),
}));

const docker = vi.mocked(runDocker);

const API = "https://api.cloudflare.com/client/v4/accounts/acc/containers";
const MANIFESTS = "https://registry.cloudflare.com/v2/ext1/sandbox/manifests";
const DIGEST = `sha256:${"a".repeat(64)}`;

let root: string;

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  root = mkdtempSync(path.join(os.tmpdir(), "container-image-"));
  setConfigFile(path.join(root, "notation.config.ts"));
  mkdirSync(path.join(root, "sandbox"));
  writeFileSync(path.join(root, "sandbox/Dockerfile"), "FROM alpine\n");
  writeFileSync(path.join(root, "sandbox/server.js"), "console.log(1)\n");
  docker.mockReset();
  docker.mockResolvedValue("");
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Answers the account, credentials and manifest requests of one account
// whose registry namespace is `ext1`. `digest` is the digest of each tag, or
// null when the registry has none.
function mockRegistry(digest: string | null = DIGEST) {
  mockFetch((call) => {
    if (call.url === `${API}/me`) return ok({ external_account_id: "ext1" });
    if (call.url.endsWith("/credentials")) {
      return ok({ username: "user", password: "secret" });
    }
    if (call.url.startsWith(MANIFESTS)) {
      return digest
        ? new Response(null, { headers: { "Docker-Content-Digest": digest } })
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 500 });
  });
}

function sandboxImage(config: Record<string, unknown> = {}) {
  return new ContainerImage("sandbox:image", {
    config: { Repository: "sandbox", Context: "sandbox", ...config },
  });
}

async function tagOf(config: Record<string, unknown> = {}) {
  const params = await sandboxImage(config).getParams();
  return params.Tag;
}

describe("ContainerImage params", () => {
  it("takes the account from the environment, and a tag from the hash of the build's input", async () => {
    const params = await sandboxImage().getParams();

    expect(params).toMatchObject({
      AccountId: "acc",
      Repository: "sandbox",
      Context: "sandbox",
    });
    expect(params.Tag).toMatch(/^[a-f0-9]{32}$/);
    expect(await tagOf()).toBe(params.Tag);
  });

  it("changes the tag when a file in the build context changes", async () => {
    const before = await tagOf();
    writeFileSync(path.join(root, "sandbox/server.js"), "console.log(2)\n");

    expect(await tagOf()).not.toBe(before);
  });

  it("changes the tag when a file is added or renamed", async () => {
    const before = await tagOf();
    writeFileSync(path.join(root, "sandbox/other.js"), "console.log(1)\n");
    const added = await tagOf();
    rmSync(path.join(root, "sandbox/other.js"));
    writeFileSync(path.join(root, "sandbox/renamed.js"), "console.log(1)\n");

    expect(added).not.toBe(before);
    expect(await tagOf()).not.toBe(added);
  });

  it("changes the tag when a file's mode changes", async () => {
    const before = await tagOf();
    chmodSync(path.join(root, "sandbox/server.js"), 0o755);

    expect(await tagOf()).not.toBe(before);
  });

  it("changes the tag when a build arg changes", async () => {
    const before = await tagOf({ BuildArgs: { VERSION: "1" } });

    expect(await tagOf({ BuildArgs: { VERSION: "2" } })).not.toBe(before);
  });

  it("changes the tag when a Dockerfile outside the context changes", async () => {
    writeFileSync(path.join(root, "Dockerfile.sandbox"), "FROM alpine\n");
    const before = await tagOf({ Dockerfile: "Dockerfile.sandbox" });
    writeFileSync(path.join(root, "Dockerfile.sandbox"), "FROM debian\n");

    expect(await tagOf({ Dockerfile: "Dockerfile.sandbox" })).not.toBe(before);
  });

  it("skips the .git directory", async () => {
    const before = await tagOf();
    mkdirSync(path.join(root, "sandbox/.git"));
    writeFileSync(path.join(root, "sandbox/.git/HEAD"), "ref: main\n");

    expect(await tagOf()).toBe(before);
  });

  it("throws when the build context or the Dockerfile is missing", async () => {
    await expect(
      sandboxImage({ Context: "missing" }).getParams(),
    ).rejects.toThrow(`The build context ${root}/missing was not found`);
    rmSync(path.join(root, "sandbox/Dockerfile"));
    await expect(sandboxImage().getParams()).rejects.toThrow(
      `The Dockerfile ${root}/sandbox/Dockerfile was not found`,
    );
  });

  it("keeps the paths and the build args out of state", () => {
    const image = sandboxImage();

    expect(image.schema.Context.hidden).toBe(true);
    expect(image.schema.Dockerfile.hidden).toBe(true);
    expect(image.schema.BuildArgs.hidden).toBe(true);
  });

  it.each(["sandbox", "team/sandbox", "my-app_1.web", "a__b"])(
    "accepts the repository %j",
    async (name) => {
      const result =
        await sandboxImage().schema.Repository.value["~standard"].validate(
          name,
        );
      expect(result.issues).toBeUndefined();
    },
  );

  it.each(["Sandbox", "", "-sandbox", "sandbox-", "a..b", "a/", "a:b"])(
    "rejects the repository %j",
    async (name) => {
      const result =
        await sandboxImage().schema.Repository.value["~standard"].validate(
          name,
        );
      expect(result.issues).toBeDefined();
    },
  );
});

describe("ContainerImage", () => {
  const image = new ContainerImage("image", {
    config: {} as any,
  });

  async function params() {
    return await sandboxImage({ BuildArgs: { VERSION: "1" } }).getParams();
  }

  it("checks Docker, builds the image under its tag, then logs in to the registry and pushes it", async () => {
    mockRegistry();
    const p = await params();

    await image.create(p);

    const reference = `registry.cloudflare.com/ext1/sandbox:${p.Tag}`;
    expect(docker.mock.calls).toEqual([
      [["info", "--format", "{{.ServerVersion}}"]],
      [
        [
          "build",
          "--load",
          "--platform",
          "linux/amd64",
          "--provenance=false",
          "-t",
          reference,
          "-f",
          path.join(root, "sandbox/Dockerfile"),
          "--build-arg",
          "VERSION=1",
          path.join(root, "sandbox"),
        ],
      ],
      [
        [
          "login",
          "--password-stdin",
          "--username",
          "user",
          "registry.cloudflare.com",
        ],
        { stdin: "secret" },
      ],
      [["push", reference]],
    ]);
    expect(calls).toEqual([
      { method: "GET", url: `${API}/me`, body: undefined },
      {
        method: "POST",
        url: `${API}/registries/registry.cloudflare.com/credentials`,
        body: JSON.stringify({
          expiration_minutes: 15,
          permissions: ["push", "pull"],
        }),
      },
    ]);
  });

  it("says to start Docker when `docker info` fails, before any request", async () => {
    mockRegistry();
    docker.mockRejectedValueOnce(
      new DockerCommandError(["info"], 1, "Cannot connect to the daemon"),
    );

    await expect(image.create(await params())).rejects.toThrow(
      /needs a running Docker daemon.*Start Docker[\s\S]*Cannot connect to the daemon/,
    );
    expect(docker).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("says to install Docker when the CLI is not found", async () => {
    mockRegistry();
    docker.mockRejectedValueOnce(new DockerNotFoundError());

    await expect(image.create(await params())).rejects.toThrow(
      /needs the Docker CLI, which was not found on PATH/,
    );
  });

  it("fails when the build fails, and pushes nothing", async () => {
    mockRegistry();
    docker.mockImplementation(async (args) => {
      if (args[0] === "build") {
        throw new DockerCommandError(args, 1, "ERROR: failed to solve");
      }
      return "";
    });

    await expect(image.create(await params())).rejects.toThrow(
      /docker build exited with code 1:\nERROR: failed to solve/,
    );
    expect(docker.mock.calls.map(([args]) => args[0])).not.toContain("push");
  });

  it("reads the image pinned by the digest that the registry has for the tag", async () => {
    mockRegistry();
    const key = { AccountId: "acc", Repository: "sandbox", Tag: "abc123" };

    await expect(image.read!(key)).resolves.toEqual({
      ...key,
      Image: `registry.cloudflare.com/ext1/sandbox@${DIGEST}`,
    });
    const head = calls.find((call) => call.method === "HEAD");
    expect(head?.url).toBe(`${MANIFESTS}/abc123`);
    const init = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => init?.method === "HEAD")?.[1];
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("v1:secret").toString("base64")}`,
    });
  });

  it("reports an image that the registry doesn't have as not found", async () => {
    mockRegistry(null);

    await expect(
      image.read!({ AccountId: "acc", Repository: "sandbox", Tag: "abc123" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("leaves the image in the registry on delete", async () => {
    mockRegistry();

    await image.delete(
      { AccountId: "acc", Repository: "sandbox", Tag: "abc123" },
      {} as any,
    );
    expect(calls).toEqual([]);
    expect(docker).not.toHaveBeenCalled();
  });
});

describe("ContainerImage in a ContainerApplication", () => {
  function deployedPair() {
    const script = new WorkerScript("worker:api", {
      config: {
        CompatibilityDate: "2026-10-12",
        DurableObjectNamespaces: [
          { id: "sandboxes", className: "Sandbox", container: true },
        ],
      },
      dependencies: {} as any,
    });
    script.setOutput({
      AccountId: "acc",
      ScriptName: "app--dev--api",
    } as typeof script.output);
    const image = sandboxImage();
    const application = new ContainerApplication("app", {
      config: {
        Name: "app-dev-sandbox",
        HostedNamespaceId: "sandboxes",
        MaxInstances: 1,
        Configuration: { image: image.outputRef("Image") },
      },
      dependencies: { script },
    });
    return { image, application };
  }

  it("depends on the image whose output ref is in Configuration.image", () => {
    const { image, application } = deployedPair();

    expect(application.getDependencies()).toContain(image);
  });

  it("takes the image's digest-pinned reference at deploy", async () => {
    const { image, application } = deployedPair();
    const pinned = `registry.cloudflare.com/ext1/sandbox@${DIGEST}`;
    image.setOutput({
      AccountId: "acc",
      Repository: "sandbox",
      Tag: "abc123",
      Image: pinned,
    } as typeof image.output);

    await expect(application.getParams()).resolves.toMatchObject({
      Configuration: { image: pinned },
    });
  });

  it("plans an unknown image while the image has no output, as after a replace", async () => {
    const { application } = deployedPair();

    await expect(application.planParams()).resolves.toMatchObject({
      Configuration: { image: UNKNOWN_AFTER_APPLY },
    });
  });
});
