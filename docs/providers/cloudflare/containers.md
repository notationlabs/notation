# Containers

`@notation/cloudflare/resources` declares Cloudflare Containers with three resources:

- `containers.ContainerImage` builds an image with Docker, and pushes it to the account's Cloudflare registry.
- `containers.ContainerApplication` runs the containers of a Durable Object namespace that a `WorkerScript` hosts.
- `containers.ContainerRegistry` gives Containers the credentials to pull images from a private registry, such as AWS ECR.

For now, containers can only be declared with the resources API. The Durable Object namespaces that `$worker` and `$durableObject` declare can't run containers.

## Example

The infra below builds the image in `sandbox/`, and runs it for the `Sandbox` class of a Worker:

```ts [infra/main.ts]
import { containers, workers } from "@notation/cloudflare/resources";
import { fs } from "@notation/std/resources";

const code = new fs.File("worker:api:code", {
  config: { filePath: "worker/index.js" },
});

const script = new workers.WorkerScript("worker:api", {
  config: {
    CompatibilityDate: "2026-10-12",
    Bindings: [
      {
        type: "durable_object_namespace",
        name: "SANDBOX",
        class_name: "Sandbox",
      },
    ],
    DurableObjectNamespaces: [
      { id: "sandboxes", className: "Sandbox", container: true },
    ],
  },
  dependencies: { code },
});

const image = new containers.ContainerImage("sandbox:image", {
  config: { Repository: "sandbox", Context: "sandbox" },
});

new containers.ContainerApplication("sandbox", {
  config: {
    Name: "sandbox",
    HostedNamespaceId: "sandboxes",
    MaxInstances: 5,
    Configuration: { image: image.outputRef("Image"), instance_type: "lite" },
  },
  dependencies: { script },
});
```

`image.outputRef("Image")` is the image's reference, pinned by its digest, such as `registry.cloudflare.com/<account>/sandbox@sha256:...`. Deploy fills it in once the image is pushed. The application depends on the image, so deploy pushes the image before it creates or updates the application.

## `ContainerImage`

| Param        | Description                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Repository` | Required. The repository in the account's Cloudflare registry, such as `sandbox` or `team/sandbox`. Use lowercase letters, digits, `.`, `_` and `-`. Changing it replaces the image. |
| `Context`    | Required. The build context directory, relative to the project root.                                                                                                                 |
| `Dockerfile` | The Dockerfile, relative to the project root. Defaults to `Dockerfile` in the build context.                                                                                         |
| `BuildArgs`  | Values for `docker build --build-arg`, by name. Don't put secrets here: Docker keeps the values in the image's history.                                                              |

The output `Image` is the image pinned by the digest that the registry holds for the pushed tag.

### Docker

Deploy runs the `docker` CLI on the machine that runs `notation deploy`. Docker, or a tool that provides the `docker` CLI and daemon such as OrbStack or Colima, must be installed and running. Deploy runs `docker info` first, and fails with a message to start Docker when the daemon doesn't answer. Plan doesn't need Docker. To read an image, plan and deploy request pull credentials for the registry, and ask the registry for the tag's digest.

To push an image, deploy:

1. Gets the account's namespace in the registry from Cloudflare.
2. Runs `docker build --load --platform linux/amd64 --provenance=false`. Cloudflare runs containers on `linux/amd64` only. Provenance is turned off so that the registry holds one image manifest, not an index.
3. Gets push credentials for `registry.cloudflare.com` that expire after 15 minutes, and runs `docker login` with them. This step comes after the build, because a build can take longer than 15 minutes.
4. Runs `docker push`.

`docker login` saves the credentials in your Docker config, as `wrangler deploy` does.

### Changes

The image's tag is the first 32 hex characters of a SHA-256 of the build's input:

- the path, permission bits and bytes of each file in the build context, and the target of each symbolic link,
- the Dockerfile,
- the build args,
- the platform.

Plan and deploy hash the input on each run. When the input changes, the tag changes, and deploy replaces the image: it builds and pushes the image under the new tag. The application's `Configuration.image` then holds the new digest, so deploy starts a rollout. When the input is the same, the tag is the same, and deploy builds nothing.

Each `.git` directory in the build context is skipped. `.dockerignore` is not read, so a change to a file that it excludes also builds the image again. A rebuild from Docker's cache usually has the same digest, and the same digest starts no rollout. To keep plans fast, use a build context directory that holds only the files that the image needs.

A change to `Context`, `Dockerfile` or `BuildArgs` that leaves the input the same changes nothing. These params are not kept in state.

When a deploy stops after the push and runs again, it pushes the same tag again, and nothing changes.

### Delete

Deleting a `ContainerImage` leaves the image in the registry. When deploy replaces an image, it deletes the old image before the application's rollout of the new image ends, and the application may still start instances from the old digest until then. The delete runs the same way for a replace and a destroy, so it deletes no image in either case. To delete old images, run `wrangler containers images list` and `wrangler containers images delete`.

When the registry no longer has the image's tag, deploy builds and pushes the image again.

## `ContainerApplication`

A change to `Configuration` starts a rollout that replaces the instances, 25% of them at a time. Pin the image by its digest. A new image pushed under the same tag doesn't change `Configuration`, so it starts no rollout.

An application that pulls its image from a private registry should `dependOn` the `ContainerRegistry` for that registry.

## Credentials

Deploy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See [Credentials](workers.md#credentials). The token also needs the Containers: Edit permission, because plan and deploy request registry credentials to read each `ContainerImage`.
