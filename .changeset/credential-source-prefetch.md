---
"@notation/resource": minor
"@notation/reconciler": minor
---

`credentialSourceResource()` takes an optional operation, `prefetch(sources, context)`. Plan and deploy call it once for each class of source, with every source of the class that depends on no other resource and whose params are known, before they plan or change any resource. The other sources are fetched by their own `read`. Each delivery of the deploy workflow calls `prefetch` again: a resume, or a wake after the deployment hold or a retry delay. `destroy` does not call it.

- `prefetch` returns `{ prefetched, failed }`. The engine keeps `prefetched` in memory until the plan or deploy ends, and passes it to the class's `read` and `loadCredential` as `context.prefetched`. It never writes it to the journal or to state.
- When `failed` is not empty, plan and deploy throw one `SourcePrefetchError`, which lists every failed source with its scrubbed message. In a plan, or in the first delivery of a deploy, nothing has changed at this point.
- `context.notify(message)` emits a `reconciler.source.notice` event, which pretty output shows as `… <message> (<type>)`.
