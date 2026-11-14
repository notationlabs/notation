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
import { hashBuildInput, PLATFORM, type BuildInput } from "./build-context";
import { DockerCommandError, runDocker } from "./docker";

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
      v.regex(
        /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/,
        "A repository name must be lowercase, such as sandbox or team/sandbox",
      ),
    ),
  },
  Tag: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    primaryKey: true,
    value: v.string(),
  },
  // The paths and build args are hidden, so that a change to them that
  // leaves the build's input the same doesn't replace the image. The tag
  // changes when the input changes.
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
 * Builds a container image with Docker for `linux/amd64`, and pushes it to
 * the account's Cloudflare registry. The tag is the start of a SHA-256 of
 * the files in the build context, the Dockerfile, the build args and the
 * platform, so a change to any of them replaces the image. `.dockerignore`
 * is not read. Delete leaves the image in the registry.
 *
 * Each read requests short-lived pull credentials, so plan needs a token
 * with the Containers: Edit permission.
 */
export const ContainerImage = containerImageSchema
  .defineOperations({
    // Running create again with the same input pushes the same tag, so a
    // retried deploy is safe.
    create: async (params) => {
      await assertDockerRunning();
      const input = buildInput(params);
      const namespace = await registryNamespace(params.AccountId);
      const reference = `${CLOUDFLARE_REGISTRY}/${namespace}/${params.Repository}:${params.Tag}`;
      await runDocker([
        "build",
        "--load",
        "--platform",
        PLATFORM,
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
      // The credentials expire after 15 minutes, so they are requested after
      // the build, which can take longer. `docker login` saves them in the
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

    // `Image` holds the digest that the registry has for the tag, which is
    // the digest that Cloudflare pulls.
    read: async (key) => {
      const namespace = await registryNamespace(key.AccountId);
      const credentials = await registryCredentials(key.AccountId, ["pull"]);
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
  };
}

async function assertDockerRunning(): Promise<void> {
  try {
    await runDocker(["info", "--format", "{{.ServerVersion}}"]);
  } catch (error) {
    if (!(error instanceof DockerCommandError)) throw error;
    throw new Error(
      `Building a container image needs a running Docker daemon, and \`docker info\` failed. Start Docker, and deploy again.\n${error.output}`,
      { cause: error },
    );
  }
}
