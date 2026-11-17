---
"@notation/cloudflare": minor
---

A Worker can bind a Worker Loader with `workerLoader()`, from `@notation/cloudflare/workers`: `bindings: () => ({ LOADER: workerLoader() })`. In the Worker, `env.LOADER` is a `WorkerLoader`, which runs code that the Worker receives at runtime in a new isolate. The binding has no resource, so deploy creates and deletes nothing for it. It needs no compatibility flag.
