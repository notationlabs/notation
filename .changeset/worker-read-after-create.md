---
"@notation/cloudflare": patch
---

Cloudflare sometimes reports a Worker as not found for about a second after the upload that created it, which failed the deploy. `WorkerScript`'s create now reads the Worker after the upload, and reads it again every 250 ms until Cloudflare finds it. If Cloudflare still reports the Worker as not found 15 seconds after the upload, the create fails.
