---
"@notation/resource": minor
"@notation/reconciler": minor
---

`credentialSourceResource()` takes an optional operation, `prefetch(sources, context)`. Plan and deploy call it once for each class of source, with every source of the class that depends on no other resource and whose params are known, before they plan or change any resource. The other sources are fetched by their own `read`. Deploy calls it inside the deployment hold, in each delivery of the deploy workflow until one call has succeeded. A later delivery of the deploy workflow, such as a resume or a wake after a retry delay, calls it once at the first `read` or `loadCredential` that runs, and does not call it when it replays every `read` and loads no value. `destroy` does not call it.

- `prefetch` returns `{ prefetched, failed }`. The engine keeps `prefetched` in memory until the plan or deploy ends, and passes it as `context.prefetched` to the `read` and `loadCredential` of each source of the class that depends on no other resource. It never writes it to the journal or to state.
- When `failed` is not empty, plan and deploy throw one `SourcePrefetchError`, which lists every failed source with its scrubbed message. In a plan, or in the call at the start of a deploy, nothing has changed at this point. In a later delivery, resources can have changed before it.
- `context.notify(message)` emits a `reconciler.source.notice` event, which pretty output shows as `… <message> (<type>)`.
