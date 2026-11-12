---
"@notation/cloudflare": patch
---

`WorkerScript` keeps the Worker's secrets when it uploads the Worker. The upload sends `keep_bindings: ["secret_text", "secret_key"]`, so Cloudflare keeps the secrets of the Worker's latest version. Before, an upload removed every secret that was set with wrangler or in the dashboard.

A rate-limited Cloudflare request now throws a `ResourceOperationPendingError` with `throttled: true`. After a create with an unknown outcome, the reconciler no longer reads a rate-limited lookup as finding the resource. It looks the resource up again later.
