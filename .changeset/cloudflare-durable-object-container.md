---
"@notation/cloudflare": minor
---

`$durableObject` takes `container`, which runs a container for each object of the namespace. It sets the image (`context`, `dockerfile`, `buildArgs` and `repository`), `maxInstances`, and the size, environment variables and network of the containers. The hosting Worker's group then has a `ContainerImage` and a `ContainerApplication` for the namespace, and the Worker's upload sends the class in `containers`. The application is named `<app>-<stage>-<id>-<hash>`, as Cloudflare refuses a name with `--`. A namespace without `container` has no `container` key, so the params of a Worker that was deployed before this change stay the same.
