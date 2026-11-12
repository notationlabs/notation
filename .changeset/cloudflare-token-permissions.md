---
"@notation/cloudflare": patch
---

The error for a missing `CLOUDFLARE_API_TOKEN` now lists the token permission for each resource: Workers Scripts: Edit for `WorkerScript`, Workers KV Storage: Edit for `KVNamespace`, Workers R2 Storage: Edit for `R2Bucket`, and Workers Containers: Edit for `ContainerApplication` and `ContainerRegistry`. It used to say that the token needs only Workers Scripts: Edit.
