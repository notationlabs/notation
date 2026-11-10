---
"@notation/cloudflare": minor
---

New package. `@notation/cloudflare/workers` declares Cloudflare Workers and Durable Object namespaces, in runtime modules, as RFC 0015 describes.

- `$worker({ id, bindings, compatibilityDate, compatibilityFlags, url })` declares the Worker that its module deploys as. The module has a default export. `bindings` binds a namespace from `$durableObject` as a Durable Object namespace, another Worker as a service binding, and a string as plain text. `WorkerEnv<typeof worker>` and `WorkerHandler<typeof worker>` type `env` and the default export. The Worker is named `<app>--<stage>--<id>`, and is served on workers.dev unless `url` is `false`. `compatibilityDate` is required. `nodejs_compat` is always added to the compatibility flags.
- `$durableObject({ id, class })` declares a namespace. The Worker that binds the namespace and exports its class hosts it. Other Workers that bind it bind it on that Worker, and are uploaded after it. Plan fails, naming the Worker's module, when no Worker that binds the namespace exports the class, or when two do.
- This departs from RFC 0015 decision 3: the user exports the class from the Worker's module, under its own name, and deploy doesn't add the export.
- A new namespace uses SQLite storage. Deploy uploads Cloudflare's declarative `exports` map. A namespace whose class changes, with the same `id`, is renamed and keeps its objects. A namespace whose declaration is removed is deleted, with its objects.
- `@notation/cloudflare/resources` exports the resources `cloudflare/workers/WorkerScript`, which uploads a Worker with its bindings and namespaces, and `cloudflare/workers/WorkerSubdomain`, which serves it on workers.dev. They read `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account is stored in state.
