---
"@notation/cloudflare": patch
---

A rate-limited Cloudflare request now throws a pending error marked as throttled, so a create lookup that is rate-limited runs again later instead of counting as finding the resource.
