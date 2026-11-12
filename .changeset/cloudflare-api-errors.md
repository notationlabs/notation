---
"@notation/cloudflare": patch
---

- A `WorkerScript` read or delete treats the Worker as not found only when Cloudflare returns error code 10007. Any other 404 fails with the API error, so a delete no longer drops a Worker from state while it still runs.
- A `WorkerScript` delete that fails because the Worker consumes a queue (code 10064), or because another Worker has a service binding to it (code 10142), fails with a message that names the cause.
- A `WorkerSubdomain` read on an account with no workers.dev subdomain fails with a message that says how to set one up. A 404 with code 7003 still fails with the API error.
