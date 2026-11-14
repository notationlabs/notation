---
"@notation/cloudflare": minor
---

The `cloudflare/tokens/AccountToken` resource has the params `Condition`, `ExpiresOn` and `NotBefore`. `Condition` holds the client IP ranges that may or may not use the token, and the times are ISO 8601 times in UTC. A change to any of them updates the token in place, and the token keeps its value. If the IP ranges are changed in the dashboard, deploy changes them back.

`accountToken()` from `@notation/cloudflare/tokens` has the option `condition`. It has no option for an expiry time, because the token isn't rotated when it expires.
