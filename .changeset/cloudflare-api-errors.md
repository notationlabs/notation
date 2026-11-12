---
"@notation/cloudflare": patch
---

- A `WorkerScript` read or delete treats the Worker as not found only when Cloudflare returns error code 10007. Any other 404 fails with the API error, so a delete no longer drops a Worker from state while it still runs.
- A `WorkerSubdomain` read on an account with no workers.dev subdomain (code 10007) fails with a message that says how to set one up. Any other 404 still fails with the API error.
