---
"@notation/resource": minor
"@notation/cloudflare": minor
"@notation/build": minor
---

Infra code reads a Worker's URL while infra runs (RFC 0026). `$worker` and `worker()` return a value with `url`, an `OutputRef<string>` of the Worker's workers.dev URL, which config, a contribution or a binding takes, and `text`, `map` and `all` compute with: `` text`${api.url}/github/webhook` ``.

- `@notation/resource` exports `deferredOutputRef({ resourceId, path, resolve })`, which makes a ref to an output of a resource that is created once the infra modules have loaded. `OutputRef.resource` is a getter. For a deferred ref, its first read calls `resolve`, and a read while the modules load throws. Each ref has `resourceId`, which `OutputRefStringError` and the canonical form of a ref read, so neither finds the resource.
- `@notation/cloudflare`: `url` is the same ref on each read, and is not enumerable, so a copy made with spread syntax has none. A resource that holds it depends on the Worker's `WorkerSubdomain`. For `url: false`, the type has no `url`, and a read throws. `url` is typed from the `url` option, and a `boolean` that isn't a literal gives `url`.
- A Worker's plain text binding to an output ref or a derived value is a contribution to its script, as a service binding is. So a Worker can bind its own URL with `addBindings(api, { OWN_URL: api.url })`, and two Workers can bind each other's. On the first deploy, such a Worker is uploaded twice. Before, such a binding was in the script's config. An existing Worker that binds an output ref or a derived value is updated once on its first deploy after this release: those bindings are now contributions, so they come after the fixed bindings, in canonical order.
- A container's `environmentVariables` can be a function, which is called once every infra module has loaded, so it can name the Worker that hosts the namespace. Annotate its return type, `Record<string, Input<string>>`, when it names a Worker that binds the namespace.
- `@notation/build` parses an `outputs:` clause in the `@declaration` mark. A runtime build fails a module that reads a listed output of a declaration, such as `api.url` in Worker code, and names the file and line. The runtime `$worker` throws for a read that the build can't follow.
