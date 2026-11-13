---
"@notation/cloudflare": patch
---

Cloudflare sometimes reports a Worker as not found for about a second after the upload that created it, which failed the deploy. For 15 seconds after deploy creates a Worker, `WorkerScript`'s read now throws `ResourceOperationPendingError` instead of `ResourceNotFoundError`, so the reconciler reads it again after a second.
