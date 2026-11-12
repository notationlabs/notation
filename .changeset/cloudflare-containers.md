---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports two resources for Cloudflare Containers.

- `cloudflare/containers/ContainerApplication` runs the containers of a Durable Object namespace. A change to `Configuration` starts a rollout that replaces the instances 25% at a time. The Worker that hosts the namespace must declare its class as a container class, and notation's `WorkerScript` doesn't support container classes yet. For now, deploy that Worker another way and set `DurableObjectNamespaceId` by hand.
- `cloudflare/containers/ContainerRegistry` gives Containers the credentials to pull images from a private registry. A change to the credentials replaces the registry.

The API token in `CLOUDFLARE_API_TOKEN` also needs the Containers permission.
