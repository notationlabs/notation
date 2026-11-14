---
"@notation/cloudflare": minor
---

`$durableObject` takes `container: true`, which declares the namespace's class as a container class. The hosting Worker's `WorkerScript` gets `container: true` on the namespace's entry in `DurableObjectNamespaces`, and the upload sends the class in `containers`. The option defaults to `false`. A namespace without it has no `container` key, so the params of a Worker that was deployed before this change stay the same.

`$worker` and `$durableObject` don't declare a container application, and `$worker` gives no access to its `WorkerScript`. So a `ContainerApplication` still can't use a namespace that `$durableObject` declares.
