import * as v from "valibot";
import path from "node:path";
import { fromProjectRoot } from "@notation/core/paths";
import { resource, ResourceNotFoundError } from "@notation/resource";
import { accountId } from "src/api/client";
import {
  CLOUDFLARE_REGISTRY,
  manifestDigest,
  registryCredentials,
  registryNamespace,
} from "src/api/image-registry";
import { hashBuildInput, type BuildInput } from "./build-context";
import { DockerCommandError, DockerNotFoundError, runDocker } from "./docker";

// Cloudflare runs containers on linux/amd64 only.
const PLATFORM = "linux/amd64";

// 128 bits of the hash. A tag can be at most 128 characters.
const TAG_LENGTH = 32;

export type ContainerImageSchema = {
  Key: { AccountId: string; Repository: string; Tag: string };
  CreateParams: {
    AccountId: string;
    /**
     * The repository in the account's Cloudflare registry, such as
     * `sandbox`. The image is pushed to
     * `registry.cloudflare.com/<account>/<Repository>`.
     */
    Repository: string;
    /** The start of a SHA-256 of the build's input. */
    Tag: string;
    /** The build context directory, relative to the project root. */
    Context: string;
    /**
     * The Dockerfile, relative to the project root. Defaults to
     * `Dockerfile` in the build context.
     */
    Dockerfile?: string;
    /**
     * Passed to `docker build` as `--build-arg`. Don't put secrets here:
     * the values are kept in the image's history.
     */
    BuildArgs?: Record<string, string>;
  };
  UpdateParams: {};
  ReadResult: {
    /**
     * The image pinned by its digest, such as
     * `registry.cloudflare.com/<account>/sandbox@sha256:...`. Place
     * `outputRef("Image")` in a `ContainerApplication`'s
     * `Configuration.image`.
     */
    Image: string;
  };
};

type Params = ContainerImageSchema["CreateParams"];

const containerImage = resource<ContainerImageSchema>({
  type: "cloudflare/containers/ContainerImage",
  provider: "@notation/cloudflare/resources",
});

// The rules for a repository name in the Docker registry API: lowercase
// components separated by `/`, each joined by `.`, `_`, `__` or dashes.
const REPOSITORY_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

const containerImageSchema = containerImage.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  Repository: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.pipe(
      v.string(),
      v.maxLength(255, "A repository name must be at most 255 characters"),
      v.check(
        (name) =>
          name.split("/").every((part) => REPOSITORY_COMPONENT.test(part)),
        "A repository name must be lowercase letters and digits, joined by single dots, one or two underscores or dashes, in parts separated by slashes, such as sandbox or team/sandbox",
      ),
    ),
  },
  Tag: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.pipe(v.string(), v.regex(/^[a-f0-9]+$/)),
  },
  // The paths and build args are hidden, so that a change to them that
  // leaves the build's input the same doesn't replace the image. The tag
  // changes when the input changes. They are immutable only because the
  // image has no update.
  Context: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    hidden: true,
    value: v.string(),
  },
  Dockerfile: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    hidden: true,
    value: v.string(),
  },
  BuildArgs: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    hidden: true,
    value: v.record(v.string(), v.string()),
  },
  Image: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * Builds a container image with Docker, and pushes it to the account's
 * Cloudflare registry. `Image` is the image pinned by its digest. Place
 * `outputRef("Image")` in a `ContainerApplication`'s `Configuration.image`.
 *
 * The tag is the start of a SHA-256 of the build's input: the files in the
 * build context, the Dockerfile, the build args and the platform. A change
 * to any of them changes the tag, which replaces the image. Deploy builds
 * and pushes the new image, and the application rolls out its digest.
 * `.dockerignore` is not read, so a change to a file that it excludes also
 * builds the image again. Each `.git` directory is skipped. Docker's build
 * cache usually gives the same digest for such a build, and the same digest
 * starts no rollout.
 *
 * The image is built for `linux/amd64`, the only platform that Cloudflare
 * runs, with provenance turned off, so that the push makes one manifest.
 *
 * The delete leaves the image in the registry. An application that rolls
 * out a new image may still start instances from the old digest, and the
 * delete can't tell a replace from a destroy.
 */
export const ContainerImage = containerImageSchema
  .defineOperations({
    // A push of the same input pushes the same tag, so a create that runs
    // again after a stop takes over the image that it pushed before.
    create: async (params) => {
      await assertDockerRunning();
      const input = buildInput(params);
      const namespace = await registryNamespace(params.AccountId);
      const reference = `${CLOUDFLARE_REGISTRY}/${namespace}/${params.Repository}:${params.Tag}`;
      await runDocker([
        "build",
        "--load",
        "--platform",
        input.platform,
        "--provenance=false",
        "-t",
        reference,
        "-f",
        input.dockerfile,
        ...Object.entries(input.buildArgs).flatMap(([name, value]) => [
          "--build-arg",
          `${name}=${value}`,
        ]),
        input.context,
      ]);
      const credentials = await registryCredentials(params.AccountId, [
        "push",
        "pull",
      ]);
      // The credentials expire after 15 minutes, so they are made after the
      // build, which can take longer. `docker login` saves them in the
      // user's Docker config.
      await runDocker(
        [
          "login",
          "--password-stdin",
          "--username",
          credentials.username,
          CLOUDFLARE_REGISTRY,
        ],
        { stdin: credentials.password },
      );
      await runDocker(["push", reference]);
    },

    // The read takes the digest from the registry, so `Image` is the digest
    // that Cloudflare pulls.
    read: async (key) => {
      const namespace = await registryNamespace(key.AccountId);
      const credentials = await registryCredentials(key.AccountId, ["pull"], 5);
      const digest = await manifestDigest(
        credentials,
        namespace,
        key.Repository,
        key.Tag,
      );
      if (!digest) {
        throw new ResourceNotFoundError(
          `The registry has no image ${key.Repository}:${key.Tag}`,
        );
      }
      return {
        AccountId: key.AccountId,
        Repository: key.Repository,
        Tag: key.Tag,
        Image: `${CLOUDFLARE_REGISTRY}/${namespace}/${key.Repository}@${digest}`,
      };
    },

    delete: async () => {},
  })
  .requireDependencies<{}>()
  .deriveParams(async ({ config }) => {
    const hash = await hashBuildInput(buildInput(config));
    return { AccountId: accountId(), Tag: hash.slice(0, TAG_LENGTH) };
  });

export type ContainerImageInstance = InstanceType<typeof ContainerImage>;

function buildInput(
  params: Pick<Params, "Context" | "Dockerfile" | "BuildArgs">,
): BuildInput {
  const context = fromProjectRoot(params.Context);
  return {
    context,
    dockerfile: params.Dockerfile
      ? fromProjectRoot(params.Dockerfile)
      : path.join(context, "Dockerfile"),
    buildArgs: params.BuildArgs ?? {},
    platform: PLATFORM,
  };
}

async function assertDockerRunning(): Promise<void> {
  try {
    await runDocker(["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    if (error instanceof DockerNotFoundError) throw error;
    if (error instanceof DockerCommandError) {
      throw new Error(
        `Building a container image needs a running Docker daemon, and \`docker info\` failed. Start Docker, and deploy again.\n${error.output.slice(-1_000)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
