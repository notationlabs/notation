---
"@notation/utils": patch
"@notation/aws": patch
"@notation/cloudflare": patch
---

The `id` option of `kvJson()`, `queue()`, `jwtAuthorizer()`, `api()`, `eventBus()`, `rule()`, `schedule()`, `lambda()` and `$lambda` takes an id built from another id. `NameSafe` and `IdOption` still check a string literal such as `"flags"` in full. A template literal type such as `${string}-config` now passes when its fixed parts hold only letters, digits, hyphens and underscores, so `${string}.config` is still a type error. Plain `string` now passes. The holes of a template and a plain string are checked when the resource is declared, as before.
