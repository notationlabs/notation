# Containers

Cloudflare Containers pairs each Durable Object instance with a Linux container. Attach `container` to `$durableObject` for local Docker builds, or compose `ContainerImage`, `ContainerApplication`, and `ContainerRegistry` in `infra/` for custom images and private registries.

Deploying Containers requires a Cloudflare **Workers Paid** plan with Containers enabled, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` with `Workers Scripts: Edit` and `Containers: Edit` (see [Cloudflare Overview](./overview.md)), and a running Docker daemon with Buildx for local builds.

## Durable Object containers

Pair a `Dockerfile`, a `$durableObject` class that starts and proxies `this.ctx.container`, and a hosting `$worker`:

::code-group

```dockerfile [containers/order-runner/Dockerfile]
FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
EXPOSE 8080
CMD ["node", "server.mjs"]
```

```ts [runtime/order-runner.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class OrderRunner extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return new Response("Container runtime disabled", { status: 500 });
    if (!container.running) container.start();
    return await container.getTcpPort(8080).fetch(request);
  }
}

export const orderRunners = $durableObject({
  id: "order-runners",
  class: OrderRunner,
  container: {
    image: { context: "containers/order-runner" },
    maxInstances: 4,
    instanceType: "basic",
    environmentVariables: { LOG_LEVEL: "info" },
  },
});
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { orderRunners } from "./order-runner";
export { OrderRunner } from "./order-runner";

export const api = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ORDER_RUNNERS: orderRunners }),
});

export default {
  async fetch(request, env) {
    return env.ORDER_RUNNERS.getByName("default").fetch(request);
  },
} satisfies WorkerHandler<typeof api>;
```

::

When a Worker binds `orderRunners` and exports `OrderRunner`, Notation enables containers on that `WorkerScript` and adds `ContainerImage` and `ContainerApplication` to its `WorkerGroup`. Moving `export { OrderRunner }` to another Worker transfers the namespace and recreates `ContainerApplication` there; removing `container` deletes only `ContainerApplication`.

To pass outputs declared later (such as `api.url`) into container environment variables, pass a callback with an explicit return type (`(): Record<string, Input<string>> => ({ API_URL: api.url })`) so TypeScript avoids circular inference on the hosting Worker.

## Custom images

Instantiate `ContainerImage` from `@notation/cloudflare/resources` in `infra/` to build a `linux/amd64` Docker image, push it to `registry.cloudflare.com`, and obtain a digest-pinned `Image` output:

```ts [infra/image.ts]
import { containers } from "@notation/cloudflare/resources";

export const orderRunnerImage = new containers.ContainerImage("order-runner:image", {
  config: {
    Repository: "team/order-runner",
    Context: "containers/order-runner",
    Dockerfile: "containers/order-runner/Dockerfile",
    BuildArgs: { NODE_ENV: "production" },
  },
});
```

## Custom applications

Wire `ContainerApplication` directly in `infra/` to attach custom CPU, memory, disk, or network settings to a container-enabled Durable Object namespace (`container: true`) on a `WorkerScript`:

```ts [infra/orders-container.ts]
import { containers, workers } from "@notation/cloudflare/resources";
import { fs } from "@notation/std/resources";

const code = new fs.File("worker:api:code", { config: { filePath: "worker/index.js" } });

export const apiScript = new workers.WorkerScript("worker:api", {
  config: {
    CompatibilityDate: "2026-10-12",
    Bindings: [{ type: "durable_object_namespace", name: "ORDER_RUNNERS", class_name: "OrderRunner" }],
    DurableObjectNamespaces: [{ id: "order-runners", className: "OrderRunner", container: true }],
  },
  dependencies: { code },
});

const image = new containers.ContainerImage("order-runner:image", {
  config: { Repository: "order-runner", Context: "containers/order-runner" },
});

export const orderRunnerApp = new containers.ContainerApplication("order-runner", {
  config: {
    Name: "orders-dev-runner",
    HostedNamespaceId: "order-runners",
    MaxInstances: 4,
    Configuration: {
      image: image.outputRef("Image"),
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 4000 },
      environment_variables: [{ name: "LOG_LEVEL", value: "info" }],
      network: { mode: "private" },
    },
  },
  dependencies: { script: apiScript },
});
```

## Private registries

Register pull credentials with `ContainerRegistry` and call `.dependOn(registry)` on `ContainerApplication` to pull digest-pinned images from private `"DockerHub"`, `"ECR"`, or `"GAR"` repositories:

```ts [infra/private-registry.ts]
import { containers } from "@notation/cloudflare/resources";
import { apiScript } from "./orders-container";

const registry = new containers.ContainerRegistry("ecr-registry", {
  config: {
    Domain: "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    Kind: "ECR",
    Auth: {
      public_credential: process.env.ECR_PULL_ACCESS_KEY_ID!,
      private_credential: { store_id: process.env.CF_SECRETS_STORE_ID!, secret_name: "orders-ecr-pull-secret" },
    },
  },
});

export const privateRunnerApp = new containers.ContainerApplication("private-runner", {
  config: {
    Name: "orders-dev-private-runner",
    HostedNamespaceId: "order-runners",
    MaxInstances: 4,
    Configuration: {
      image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/order-runner@sha256:4f90b33ddca9c4d4f06527070d6e503b16d71016edea036842be2a84e60c91cb",
      instance_type: "lite",
    },
  },
  dependencies: { script: apiScript },
});

privateRunnerApp.dependOn(registry);
```

Provision the referenced Secrets Store secret separately with `"containers"` scope (see [Secrets](./secrets.md)).

## Reference

### `DurableObjectContainerConfig`

Options accepted by `container` on `$durableObject`, exported from `@notation/cloudflare/workers`:

| Option | Description |
| :--- | :--- |
| `image` | Required Docker build configuration relative to project root |
| `maxInstances` | Required integer `>= 1` capping concurrent container instances |
| `instanceType` | Optional preset size such as `"lite"`, `"basic"`, or `"standard-1"` |
| `vcpu` | Optional custom vCPU count paired with `memoryMib` |
| `memoryMib` | Optional custom memory in MiB paired with `vcpu` |
| `diskMb` | Optional disk size in MB, minimum `512` and Cloudflare default `2000` |
| `environmentVariables` | Optional plain-text environment variables object or thunk |
| `network` | Optional network mode and IP assignment settings |

`image` accepts `{ context, dockerfile?, buildArgs?, repository? }`, where `dockerfile` defaults to `Dockerfile` inside `context` and `repository` defaults to `<app>--<stage>--<id>` in lowercase; never put secrets in `buildArgs` or `environmentVariables`. `instanceType` defaults to `"lite"` when omitted and is mutually exclusive with `vcpu`, `memoryMib`, and `diskMb`; `diskMb` is valid only when both `vcpu` and `memoryMib` are set.

`network` accepts `{ mode?: "private" | "public"; assignIpv4?: "none" | "predefined"; assignIpv6?: "none" | "predefined" }`. `mode` is immutable, and setting `"predefined"` on `assignIpv4` or `assignIpv6` implies `mode: "public"`.

### `ContainerImage`

`containers.ContainerImage` (`cloudflare/containers/ContainerImage`) builds and pushes a `linux/amd64` Docker image:

| Parameter | Description |
| :--- | :--- |
| `Repository` | Required immutable Cloudflare registry repository name |
| `Context` | Required build context directory relative to project root |
| `Dockerfile` | Optional Dockerfile path relative to project root |
| `BuildArgs` | Optional `Record<string, string>` Docker build arguments |

`Repository` is capped at 255 characters with lowercase `[a-z0-9]` segments separated by `.`, `_`, `__`, `-`, or `/`. `Dockerfile` defaults to `Dockerfile` inside `Context`.

The `Image` output resolves to `registry.cloudflare.com/<namespace>/<Repository>@sha256:...`. Tags hash `Context` files (skipping `.git`; `.dockerignore` is not read), `Dockerfile`, `BuildArgs`, and `linux/amd64`, so remote `FROM` updates do not trigger rebuilds; deleting `ContainerImage` leaves the pushed image in Cloudflare's registry for active or draining rollouts.

### `ContainerApplication`

`containers.ContainerApplication` (`cloudflare/containers/ContainerApplication`) attaches a container application to a `container: true` Durable Object namespace on `dependencies.script`:

| Parameter | Description |
| :--- | :--- |
| `Name` | Required immutable application name |
| `HostedNamespaceId` | Required Durable Object namespace ID on `dependencies.script` |
| `MaxInstances` | Required integer `>= 1` capping concurrent instances |
| `Configuration` | Required container image, sizing, disk, environment, and network settings |

`Name` is 1 to 253 bytes and cannot be empty, start with a digit or `-`, end with `-`, or contain `--`. `Configuration` must set either `instance_type` or both `vcpu` and `memory_mib` (never both); `disk: { size_mb }` (`>= 512`) requires `vcpu` and `memory_mib`.

Outputs expose `ApplicationId` and `DurableObjectNamespaceId`. `MaxInstances` updates in place, while `Configuration` changes trigger a rolling rollout replacing 25% of instances at a time (pin images by digest so image changes trigger rollouts). Removing a `Configuration` key resets it to Cloudflare defaults on rollout, external edits to `Configuration` are not detected as drift, changing `network.mode` requires changing `Name` to replace the application, replacing `WorkerScript` deletes `ContainerApplication` first and recreates it, and deploying while a previous rollout is active can fail.

### `ContainerRegistry`

`containers.ContainerRegistry` (`cloudflare/containers/ContainerRegistry`) registers pull credentials for a private container registry:

| Parameter | Description |
| :--- | :--- |
| `Domain` | Required immutable lowercase registry hostname |
| `Kind` | Required immutable registry kind: `"DockerHub"`, `"ECR"`, or `"GAR"` |
| `Auth` | Required immutable `{ public_credential, private_credential }` credentials |

`Domain` is capped at 253 characters with no scheme or path, and `Auth.private_credential` takes `{ store_id, secret_name }`. Changing any field replaces the registry, creation fails if the account already has credentials for `Domain`, and external edits to `Kind` or `Auth` are not detected as drift.
