---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports two resources for Cloudflare Containers.

- `cloudflare/containers/ContainerApplication` runs the containers of a Durable Object namespace. A change to `Configuration` starts a rollout that replaces the instances 25% at a time. The application depends on the `WorkerScript` that hosts the namespace, and `HostedNamespaceId` picks the namespace from the Worker's `DurableObjectNamespaces`. The Worker is deployed first. The create then looks up the namespace's ID in the namespaces that Cloudflare lists for the Worker, and tries again until the namespace is listed. A replaced Worker gets new namespaces, so deploy deletes the application first and creates it again after the Worker. Cloudflare may merge a rollout's configuration with the current one, so removing a key from `Configuration` may not remove it from the application. This hasn't been checked against the live API, and the read doesn't return the configuration. A deploy soon after another may fail while the earlier rollout is still running.
- `cloudflare/workers/WorkerScript` takes `container: true` on an entry of `DurableObjectNamespaces`, which declares the class as a container class in the upload. The upload sends it as `containers: [{ class_name }]`. This form hasn't been checked against the live upload API: Cloudflare's docs document it only for the Versions API, and document `exports[Class].container` for the upload.
- `cloudflare/containers/ContainerRegistry` gives Containers the credentials to pull images from a private registry. A change to the credentials replaces the registry.

For now, containers can only be used through `@notation/cloudflare/resources`. The Durable Object namespaces that `$worker` and `$durableObject` declare never set `container`, so a `ContainerApplication` can't use them.

The API token in `CLOUDFLARE_API_TOKEN` also needs the Containers permission.
